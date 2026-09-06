#!/usr/bin/env tsx
/** Live, late-answer round trip through Codex and the AIR question extension. */
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCodexConnection} from "../../../../src/CodexJsonRpcConnection";
import {CodexAppServerClient} from "../../../../src/CodexAppServerClient";
import {CodexAcpClient} from "../../../../src/CodexAcpClient";
import {CodexAcpServer} from "../../../../src/CodexAcpServer";
import {ASYNC_QUESTION_REQUEST_METHOD, type AsyncQuestionRequest} from "../../../../src/AsyncQuestionExtension";
import type {AcpClientConnection} from "../../../../src/ACPSessionConnection";

const workspace = mkdtempSync(join(tmpdir(), "codex-async-question-"));
const rpc = startCodexConnection(process.env["CODEX_PATH"]);
const appServer = new CodexAppServerClient(rpc.connection);
const errors: unknown[] = [];
const questions: AsyncQuestionRequest[] = [];
const replyInputs: string[] = [];
const token = `ANSWER_${Date.now()}`;
let sessionId: string | undefined;
let output = "";
let release!: () => void;
const answerGate = new Promise<void>(done => { release = done; });
let complete!: () => void;
const followUpCompleted = new Promise<void>(done => { complete = done; });

appServer.onClientTransportEvent(event => {
    if (event.eventType === "request" && event.method === "turn/start" && event.params.threadId === sessionId) {
        for (const input of event.params.input) {
            if (input.type === "text" && input.text.startsWith("<send_user_message_question_reply>")) replyInputs.push(input.text);
        }
    }
    if (event.eventType !== "notification" || !("threadId" in event.params) || event.params.threadId !== sessionId) return;
    if (event.method === "error" && !event.params.willRetry) errors.push(event.params);
    if (event.method === "turn/completed") {
        if (event.params.turn.error) errors.push(event.params.turn.error);
        if (replyInputs.length > 0) complete();
    }
});

const connection: AcpClientConnection = {
    async notify(_method: string, params: unknown) {
        const event = params as {sessionId?: string; update?: {sessionUpdate?: string; content?: {text?: string}}};
        if (event.sessionId === sessionId && event.update?.sessionUpdate === "agent_message_chunk") {
            output += event.update.content?.text ?? "";
        }
    },
    async request<Response, Params>(method: string, params?: Params): Promise<Response> {
        assert.equal(method, ASYNC_QUESTION_REQUEST_METHOD, "Unexpected client request");
        const question = params as AsyncQuestionRequest;
        assert.equal(question.sessionId, sessionId);
        questions.push(question);
        console.log("AIR question:", JSON.stringify(question));
        await answerGate;
        return {status: "answered", answers: question.questions.map(q => ({id: q.id, answer: token}))} as Response;
    },
};
const client = new CodexAcpClient(appServer);
const agent = new CodexAcpServer(connection, client, undefined, () => rpc.process.exitCode);
let timeout: ReturnType<typeof setTimeout>;
const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Async question smoke test timed out after 90 seconds")), 90_000);
});

async function run() {
    await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: ["asyncQuestions"]}}}}});
    const session = await agent.newSession({cwd: workspace, mcpServers: []});
    sessionId = session.sessionId;
    console.log("Session:", sessionId, "model:", session.models?.currentModelId);
    await agent.prompt({sessionId, prompt: [{type: "text", text: "Protocol smoke test. Do not read or change files, run commands, or call external services. Call request_user_input_async once to ask 'What is the test token?' with no suggested answers, then finish with QUESTION_SENT without waiting for an answer. When my answer arrives later, reply with its exact token and nothing else. If request_user_input_async is not available, reply ASYNC_TOOL_UNAVAILABLE and stop."}]});
    assert.deepEqual(errors, [], "Initial Codex turn failed");
    assert.equal(questions.length, 1, `Expected one real async-question RPC. Model output: ${output}`);
    assert.ok(output.includes("QUESTION_SENT"), "Original turn must complete while the question remains unanswered");
    output = "";
    release();
    await followUpCompleted;
    await client.waitForSessionNotifications(sessionId);
    assert.deepEqual(errors, [], "Follow-up Codex turn failed");
    assert.equal(replyInputs.length, 1, "Expected exactly one new turn carrying the answer");
    const body = replyInputs[0]!.split("\n")[1]!;
    assert.deepEqual(JSON.parse(body), questions[0]!.questions.map(q => ({questionItemId: q.id, question: q.title, answer: token})));
    assert.ok(output.includes(token), `Model did not confirm the submitted token. Output: ${output}`);
    console.log("PASS: Codex async question -> AIR RPC -> late answer -> new turn input -> model confirmation");
}

try {
    await Promise.race([run(), deadline]);
} finally {
    clearTimeout(timeout!);
    rpc.connection.end();
    rpc.process.kill();
    rmSync(workspace, {recursive: true, force: true});
}
