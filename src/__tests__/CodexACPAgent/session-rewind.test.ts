import {createHash} from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {SESSION_REWIND_METHOD} from "../../SessionRewind";
import {fakeAppServer} from "../app-server-recovery/fake-app-server";
import {
    createRecoveryFixture,
    defaultAnswer,
    initialize,
    type RecoveryFixture,
    requestsOf,
} from "../app-server-recovery/recovery-fixture";

function fingerprint(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function paginatedThread(threadId: string) {
    return (defaultAnswer("thread/resume", {threadId}) as {thread: Record<string, unknown>}).thread;
}

function completedTurn(id: string, items: unknown[]) {
    return {id, items, itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null};
}

/** An app-server whose thread holds `turns`, and whose turns end right after they start. */
function answerHistory(fixture: Pick<RecoveryFixture, "answers" | "current">, turns: unknown[]): void {
    fixture.answers.set("thread/read", params => ({thread: paginatedThread((params as {threadId: string}).threadId)}));
    fixture.answers.set("thread/turns/list", params => {
        const {sortDirection, limit} = params as {sortDirection: string, limit: number};
        const ordered = sortDirection === "desc" ? [...turns].reverse() : turns;
        return {data: ordered.slice(0, limit), nextCursor: null, backwardsCursor: null};
    });
    let started = 0;
    fixture.answers.set("turn/start", params => {
        const {threadId, input, clientUserMessageId} = params as {threadId: string, input: unknown[], clientUserMessageId?: string};
        const turn = {id: `turn-new-${++started}`, items: [], status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null};
        const item = {type: "userMessage", id: `item-new-${started}`, clientId: clientUserMessageId ?? null, content: input};
        setTimeout(() => {
            const rpc = fixture.current().rpc;
            rpc.notify({method: "turn/started", params: {threadId, turn}});
            rpc.notify({method: "item/completed", params: {threadId, turnId: turn.id, item}});
            rpc.notify({method: "turn/completed", params: {threadId, turn: {...turn, status: "completed"}}});
        }, 1);
        return {turn};
    });
}

function rewindParams(sessionId: string, beforeMessage: {messageId: string, messageFingerprint?: string}) {
    return {
        sessionId,
        beforeMessage: {messageFingerprint: `sha256:${"0".repeat(64)}`, messageOccurrence: 1, ...beforeMessage},
    };
}

const HISTORY = [
    completedTurn("turn-1", [{type: "userMessage", id: "user-1", clientId: null, content: [{type: "text", text: "one", text_elements: []}]}]),
    completedTurn("turn-2", [{type: "userMessage", id: "user-2", clientId: null, content: [{type: "text", text: "two", text_elements: []}]}]),
];

describe("_session/rewind", () => {
    it("starts a prompt sent during the rewind only after Codex reverted the thread", async () => {
        const fixture = createRecoveryFixture();
        answerHistory(fixture, HISTORY);
        fixture.answers.set("thread/revert", () => undefined);
        await initialize(fixture, true);
        const {sessionId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});

        const rewind = fixture.agent.extMethod(SESSION_REWIND_METHOD, rewindParams(sessionId, {messageId: "user-2"}));
        const prompt = fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "edited"}]});
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/revert")).toHaveLength(1));
        expect(requestsOf(fixture.current(), "turn/start").filter(params => (params as {threadId: string}).threadId === sessionId)).toHaveLength(0);

        fixture.current().rpc.pending.find(request => request.method === "thread/revert")!.resolve({});

        await expect(rewind).resolves.toEqual({rewound: true});
        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
        expect(requestsOf(fixture.current(), "thread/revert")).toEqual([{threadId: sessionId, beforeTurnId: "turn-2"}]);
    });

    it("leaves the conversation as it is while a prompt runs", async () => {
        const fixture = createRecoveryFixture();
        answerHistory(fixture, HISTORY);
        fixture.answers.set("turn/start", () => undefined);
        await initialize(fixture, true);
        const {sessionId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});

        void fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "long task"}]}).catch(() => undefined);

        await expect(fixture.agent.extMethod(SESSION_REWIND_METHOD, rewindParams(sessionId, {messageId: "user-2"})))
            .resolves.toEqual({rewound: false});
        expect(requestsOf(fixture.current(), "thread/revert")).toHaveLength(0);
    });

    it("resolves a prompt with a file mention through the fingerprint of the text that history replay sent", async () => {
        const live = createRecoveryFixture();
        answerHistory(live, []);
        await initialize(live, true);
        const {sessionId} = await live.agent.newSession({cwd: "/work", mcpServers: []});
        await live.agent.prompt({
            sessionId,
            prompt: [
                {type: "text", text: "look at "},
                {type: "resource_link", name: "foo.txt", uri: "file:///work/foo.txt"},
                {type: "text", text: " please"},
            ],
        });
        // Codex stores the input of `turn/start` as the content of the user message.
        const {input} = (requestsOf(live.current(), "turn/start") as Array<{input: unknown[]}>)[0]!;
        const userMessage = {type: "userMessage", id: "restored-id", clientId: null, content: input};

        const restored = createRecoveryFixture();
        answerHistory(restored, [completedTurn("turn-1", [userMessage])]);
        restored.answers.set("thread/resume", params => ({
            ...defaultAnswer("thread/resume", params) as object,
            materialized: true,
            itemsBackwardsCursor: "cursor-1",
        }));
        restored.answers.set("thread/items/list", () => ({
            data: [{turnId: "turn-1", item: userMessage, startedAtMs: null, completedAtMs: null}],
            nextCursor: null,
            backwardsCursor: null,
        }));
        await initialize(restored, true);
        await restored.agent.loadSession({sessionId, cwd: "/work", mcpServers: []});
        const replayedText = restored.updates()
            .filter(({update}) => update["sessionUpdate"] === "user_message_chunk")
            .map(({update}) => (update["content"] as acp.ContentBlock & {type: "text"}).text)
            .join("");
        expect(replayedText).toBe("look at [@foo.txt](file:///work/foo.txt) please");

        await expect(restored.agent.extMethod(SESSION_REWIND_METHOD, rewindParams(sessionId, {
            messageId: "live-id-the-adapter-never-saw",
            messageFingerprint: fingerprint(replayedText),
        }))).resolves.toEqual({rewound: true});
        expect(requestsOf(restored.current(), "thread/revert")).toEqual([{threadId: sessionId, beforeTurnId: "turn-1"}]);
    });
});

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));

describe.each([1, 2] as const)("_session/rewind over ACP v%i", version => {
    it("serves a prompt sent right after a rewind after the rewind", async () => {
        const server = fakeAppServer();
        const answers = new Map<string, (params: unknown) => unknown>();
        server.rpc.answer = (method, params) => (answers.get(method) ?? (() => defaultAnswer(method, params)))(params);
        answerHistory({answers, current: () => server} as never, HISTORY);
        answers.set("thread/revert", () => undefined);
        const router = createAcpAgentRouter(connection =>
            new CodexAcpServer(connection, new CodexAcpClient(new CodexAppServerClient(server.rpc.connection))));
        const incoming = new TransformStream<Uint8Array, Uint8Array>();
        const outgoing = new TransformStream<Uint8Array, Uint8Array>();
        router.connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
        const connection = (version === 1 ? acp : acpV2).client({name: "rewind-test"})
            .connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
        cleanup.push(() => connection.close());
        const request = (method: string, params: unknown) => (connection.agent.request as any)(method, params);
        await request("initialize", version === 1
            ? {protocolVersion: 1, clientCapabilities: {}}
            : {protocolVersion: 2, info: {name: "rewind-test", version: "1"}, capabilities: {}});
        const {sessionId} = await request("session/new", {cwd: "/work", mcpServers: []});

        // Sent back to back, without waiting for the rewind response.
        const rewind = request(SESSION_REWIND_METHOD, rewindParams(sessionId, {messageId: "user-2"}));
        const prompt = request("session/prompt", {sessionId, prompt: [{type: "text", text: "edited"}]});
        await vi.waitFor(() => expect(requestsOf(server, "thread/revert")).toHaveLength(1));
        await new Promise(resolve => setTimeout(resolve, 20));
        const sessionTurnStarts = () => requestsOf(server, "turn/start").filter(params => (params as {threadId: string}).threadId === sessionId);
        expect(sessionTurnStarts()).toHaveLength(0);

        server.rpc.pending.find(pending => pending.method === "thread/revert")!.resolve({});

        await expect(rewind).resolves.toEqual({rewound: true});
        // v1 answers when the turn ends, v2 once Codex recorded the user message.
        await expect(prompt).resolves.toMatchObject(version === 1 ? {stopReason: "end_turn"} : {messageId: expect.any(String)});
        expect(sessionTurnStarts()).toHaveLength(1);
        await new Promise(resolve => setTimeout(resolve, 20));
    });
});
