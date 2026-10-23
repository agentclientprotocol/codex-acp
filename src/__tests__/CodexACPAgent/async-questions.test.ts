import {afterEach, describe, expect, it, vi} from "vitest";
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {ThreadItem} from "../../app-server/v2";
import {
    connectSession, sessionId, turnId, createTurn, turnStarted, turnCompleted, itemCompleted,
    userMessageItem, agentMessageDelta, settle, stateUpdates, dump, type PromptSession,
} from "./v2-prompt-harness";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}

const question: ThreadItem = {
    type: "agentMessage", id: "async-question", text: "Which theme?\n- Light\n- Dark",
    phase: "final_answer", memoryCitation: null, delivery: "async",
    questions: [{title: "Which theme?", options: ["Light", "Dark"]}],
};

function forms(client: PromptSession) {
    return client.transcript.flatMap(e => "elicitationRequest" in e ? [e.elicitationRequest] : []);
}
function text(client: PromptSession) {
    return client.transcript.flatMap(e => "sessionUpdate" in e
        && e.sessionUpdate.sessionUpdate === "agent_message_chunk" ? [e.sessionUpdate] : []);
}
async function running(client: PromptSession) {
    client.setTurnStart(async () => ({turn: createTurn("inProgress", client.turnStartParams.length === 1 ? turnId : "answer-turn")}));
    const response = client.sendPrompt([{type: "text", text: "Ask me a question"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
    await settle();
    return async () => {
        client.emit(turnCompleted());
        await response;
        await client.promptRunFinished();
    };
}

describe.each([1, 2] as const)("async questions over ACP v%i", version => {
    let client: PromptSession;
    afterEach(() => { client?.connection.close(); vi.restoreAllMocks(); });

    it("shows the question once, keeps streaming, and delivers an answer to the active turn", async () => {
        const answer = deferred<acp.CreateElicitationResponse>();
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}}, onElicitation: () => answer.promise,
        });
        const steers: unknown[] = [];
        client.setCodexResponse("turn/steer", async params => { steers.push(params); return {turnId}; });
        const finish = await running(client);
        client.emit(itemCompleted(question));
        client.emit(itemCompleted(question));
        client.emit(agentMessageDelta("Independent work continues.", turnId, "work"));
        await vi.waitFor(() => expect(text(client)).toHaveLength(2));
        expect(forms(client)).toHaveLength(1);
        expect(stateUpdates(client.transcript).some(s => s.state === "requires_action")).toBe(false);
        await expect(dump(forms(client))).toMatchFileSnapshot("data/async-question-form.json");
        answer.resolve({action: "accept", content: {question_1: "Dark"}});
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        expect(JSON.stringify(steers)).toContain('Dark');
        expect(JSON.stringify(steers)).toContain('Which theme?');
        expect(client.turnStartParams).toHaveLength(1);
        await finish();
    });

    it("retains a pending question after turn completion and accepts a custom answer in a new turn", async () => {
        const answer = deferred<acp.CreateElicitationResponse>();
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}}, onElicitation: () => answer.promise,
        });
        const finish = await running(client);
        client.emit(itemCompleted(question));
        await vi.waitFor(() => expect(forms(client)).toHaveLength(1));
        await finish();
        answer.resolve({action: "accept", content: {question_1: "Other (write below)", question_1_custom: "Follow system"}});
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        expect(JSON.stringify(client.turnStartParams[1])).toContain("Follow system");
        client.emit(turnStarted("answer-turn"));
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[1]!["clientUserMessageId"] as string), "answer-turn"));
        client.emit(turnCompleted("answer-turn"));
        await client.promptRunFinished(1);
    });

    it.each(["decline", "cancel"] as const)("does not submit a %s response", async action => {
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}}, onElicitation: () => action === "decline" ? {action: "decline"} : {action: "cancel"},
        });
        const steers = vi.fn(async () => ({turnId}));
        client.setCodexResponse("turn/steer", steers);
        const finish = await running(client);
        client.emit(itemCompleted(question));
        await vi.waitFor(() => expect(forms(client)).toHaveLength(1));
        await settle();
        expect(steers).not.toHaveBeenCalled();
        await finish();
        expect(client.turnStartParams).toHaveLength(1);
    });

    it.each([{}, {elicitation: {url: {}}}, {elicitation: {form: null}}])("falls back to text without form capability (%j)", async clientCapabilities => {
        client = await connectSession(version, {clientCapabilities});
        const finish = await running(client);
        client.emit(itemCompleted(question));
        await vi.waitFor(() => expect(text(client)).toHaveLength(1));
        expect(JSON.stringify(text(client))).toContain("Which theme?");
        expect(forms(client)).toHaveLength(0);
        await finish();
    });

    it.each(["cancel", "close"])("cancels the form on session %s and ignores a late answer", async action => {
        const answer = deferred<acp.CreateElicitationResponse>();
        let signal: AbortSignal | undefined;
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}},
            onElicitation: (_request, s) => { signal = s; return answer.promise; },
        });
        const finish = await running(client);
        client.emit(itemCompleted(question));
        await vi.waitFor(() => expect(forms(client)).toHaveLength(1));
        await finish();
        if (action === "cancel") await client.cancel();
        else await client.request("session/close", {sessionId});
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        answer.resolve({action: "accept", content: {question_1: "Light"}});
        await settle();
        expect(client.turnStartParams).toHaveLength(1);
    });

    it("accepts multiple questions including a free-text field", async () => {
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}},
            onElicitation: () => ({action: "accept", content: {question_1: "Dark", question_2: "My answer"}}),
        });
        const steers: unknown[] = [];
        client.setCodexResponse("turn/steer", async params => { steers.push(params); return {turnId}; });
        const finish = await running(client);
        client.emit(itemCompleted({...question, questions: [...question.questions!, {title: "Why?", options: null}]}));
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        expect(JSON.stringify(steers)).toContain("My answer");
        await finish();
    });

    it("does not repeat streamed text when an async item completes", async () => {
        client = await connectSession(version);
        const finish = await running(client);
        client.emit(agentMessageDelta(question.text, turnId, question.id));
        client.emit(itemCompleted(question));
        await finish();
        expect(text(client)).toHaveLength(1);
    });
    it("handles questions from a Codex-initiated turn without starting a competing turn", async () => {
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}},
            onElicitation: () => ({action: "accept", content: {question_1: "Dark"}}),
        });
        const steers: unknown[] = [];
        client.setCodexResponse("turn/steer", async params => { steers.push(params); return {turnId}; });
        client.emit(turnStarted());
        client.emit(itemCompleted(question));
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        expect(client.turnStartParams).toHaveLength(0);
        client.emit(turnCompleted());
        await settle();
    });

    it.each([
        {}, {question_1: "not listed"}, {question_1: "Other (write below)"}, {question_1: {nested: true}},
    ])("ignores invalid accepted answers (%j)", async content => {
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}},
            onElicitation: () => ({action: "accept", content}) as acp.CreateElicitationResponse,
        });
        const steers = vi.fn(async () => ({turnId}));
        client.setCodexResponse("turn/steer", steers);
        const finish = await running(client);
        client.emit(itemCompleted(question));
        await vi.waitFor(() => expect(forms(client)).toHaveLength(1));
        await settle();
        expect(steers).not.toHaveBeenCalled();
        await finish();
        expect(client.turnStartParams).toHaveLength(1);
    });

});
