import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {SESSION_REWIND_METHOD} from "../../SessionRewind";
import type {CodexAcpClient} from "../../CodexAcpClient";
import {createRecoveryFixture, defaultAnswer, initialize, requestsOf} from "./recovery-fixture";

async function setup() {
    const fixture = createRecoveryFixture();
    await initialize(fixture, true, {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}});
    const {sessionId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
    const metadata = defaultAnswer("thread/resume", {threadId: sessionId}) as {thread: Record<string, unknown>};
    let turns: unknown[] = [{
        id: "turn-original", items: [{type: "userMessage", id: "user-original", content: [{type: "text", text: "original"}]}],
        status: "completed", error: null,
    }];
    fixture.answers.set("thread/read", () => ({thread: {...metadata.thread, historyMode: "legacy", turns}}));
    fixture.answers.set("thread/rollback", () => {turns = []; return {thread: {...metadata.thread, turns}};});
    const request = {
        sessionId,
        beforeMessage: {messageId: "user-original", messageFingerprint: `sha256:${createHash("sha256").update("original").digest("hex")}`, messageOccurrence: 1},
    };
    return {...fixture, sessionId, rewind: () => fixture.agent.extMethod(SESSION_REWIND_METHOD, request)};
}

describe("rewind with current app-server recovery and session index", () => {
    it("discards a pending automatic title result when rewinding an idle session", async () => {
        const fixture = await setup();
        const title = fixture.agent.getSessionState(fixture.sessionId).titleGen!;
        const native = (fixture.agent as unknown as {codexAcpClient: CodexAcpClient}).codexAcpClient.appServerClient;
        let release!: (value: unknown) => void;
        const model = vi.spyOn(native, "runTurn").mockImplementation(() => new Promise(resolve => {
            release = value => resolve(value as never);
        }));
        title.onTurnCompleted("original");
        await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
        await expect(fixture.rewind()).resolves.toEqual({rewound: true});
        release({turn: {items: [{type: "agentMessage", text: '{"title":"Discarded title"}'}]}});
        await new Promise(resolve => setImmediate(resolve));
        expect(requestsOf(fixture.current(), "thread/name/set")).toEqual([]);
    });

    it("refuses history mutation if an earlier title write does not settle before the deadline", async () => {
        const fixture = await setup();
        const title = fixture.agent.getSessionState(fixture.sessionId).titleGen!;
        const native = (fixture.agent as unknown as {codexAcpClient: CodexAcpClient}).codexAcpClient.appServerClient;
        vi.spyOn(native, "runTurn").mockResolvedValue({turn: {items: [{type: "agentMessage", text: '{"title":"Pending title"}'}]}} as never);
        fixture.answers.set("thread/name/set", () => undefined);
        title.onTurnCompleted("original");
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/name/set")).toHaveLength(1));
        vi.useFakeTimers();
        try {
            const pending = fixture.rewind();
            const rejected = expect(pending).rejects.toMatchObject({data: expect.stringContaining("title write is still pending")});
            await vi.advanceTimersByTimeAsync(10_000);
            await rejected;
            expect(requestsOf(fixture.current(), "thread/rollback")).toEqual([]);
            fixture.current().rpc.resolve("thread/name/set", {});
            await expect(fixture.rewind()).resolves.toEqual({rewound: true});
            expect(requestsOf(fixture.current(), "thread/rollback")).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("lets close interrupt the prompt that an earlier provider update is waiting for", async () => {
        const fixture = await setup();
        fixture.agent.getSessionState(fixture.sessionId).titleGen?.markExistingTitle();
        const native = fixture.current();
        const finish = () => native.rpc.notify({method: "turn/completed", params: {
            threadId: fixture.sessionId,
            turn: {id: "active-turn", items: [], status: "interrupted", error: null},
        }});
        fixture.answers.set("turn/start", () => ({turn: {id: "active-turn", items: [], status: "inProgress", error: null}}));
        fixture.answers.set("turn/interrupt", () => {setImmediate(finish); return {};});
        const prompt = fixture.agent.prompt({sessionId: fixture.sessionId, prompt: [{type: "text", text: "running"}]});
        await vi.waitFor(() => expect(fixture.agent.getSessionState(fixture.sessionId).currentTurnId).toBe("active-turn"));
        const provider = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://example.test/v1"});
        const close = fixture.agent.closeSession({sessionId: fixture.sessionId});
        try {
            await vi.waitFor(() => expect(requestsOf(native, "turn/interrupt")).toHaveLength(1));
        } finally {
            finish();
            await Promise.all([prompt, provider, close]);
        }
    });

    it("resumes a crashed session before reading and mutating its history on the replacement process", async () => {
        const fixture = await setup();
        const old = fixture.current();
        await fixture.kill();
        await expect(fixture.rewind()).resolves.toEqual({rewound: true});
        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(old, "thread/rollback")).toEqual([]);
        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
        expect(requestsOf(fixture.current(), "thread/rollback")).toEqual([{threadId: fixture.sessionId, numTurns: 1}]);
    });

    it("blocks index writes and a second rewind while the replacement session is still opening", async () => {
        const fixture = await setup();
        await fixture.kill();
        fixture.answers.set("thread/resume", () => undefined);
        const pending = fixture.rewind();
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1));
        for (const attempt of [
            () => fixture.rewind(),
            () => fixture.agent.renameSession({sessionId: fixture.sessionId, title: "new title"}),
            () => fixture.agent.setSessionArchived({sessionId: fixture.sessionId}, true),
            () => fixture.agent.setSessionArchived({sessionId: fixture.sessionId}, false),
        ]) await expect(attempt()).rejects.toMatchObject({data: expect.stringContaining("rewinding")});
        expect(requestsOf(fixture.current(), "thread/rollback")).toEqual([]);
        fixture.current().rpc.resolve("thread/resume", defaultAnswer("thread/resume", {threadId: fixture.sessionId}));
        await expect(pending).resolves.toEqual({rewound: true});
    });

    it("leaves history untouched when reopen fails and permits a fresh attempt before mutation", async () => {
        const fixture = await setup();
        await fixture.kill();
        fixture.answers.set("thread/resume", () => new Error("cannot reopen"));
        await expect(fixture.rewind()).rejects.toThrow("cannot reopen");
        expect(requestsOf(fixture.current(), "thread/rollback")).toEqual([]);
        fixture.answers.delete("thread/resume");
        await expect(fixture.rewind()).resolves.toEqual({rewound: true});
        expect(requestsOf(fixture.current(), "thread/rollback")).toHaveLength(1);
    });

    it("does not replay a dispatched rollback when its process dies before acknowledging", async () => {
        const fixture = await setup();
        fixture.answers.set("thread/rollback", () => undefined);
        const pending = fixture.rewind();
        const failure = expect(pending).rejects.toMatchObject({code: 1001});
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/rollback")).toHaveLength(1));
        await fixture.kill();
        await failure;
        await fixture.agent.listSessions({});
        await expect(fixture.rewind()).rejects.toMatchObject({data: expect.stringContaining("outcome is uncertain")});
        expect(requestsOf(fixture.current(), "thread/rollback")).toEqual([]);
        expect(fixture.servers.flatMap(server => requestsOf(server, "thread/rollback"))).toHaveLength(1);
    });

    it("does not overtake an earlier session index rename", async () => {
        const fixture = await setup();
        let release!: () => void;
        const rename = vi.spyOn(fixture.agent.sessionIndex, "rename").mockImplementation(() => new Promise(resolve => {
            release = () => resolve({});
        }));
        const pending = fixture.agent.renameSession({sessionId: fixture.sessionId, title: "new title"});
        await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce());
        await expect(fixture.rewind()).rejects.toMatchObject({data: expect.stringContaining("update is in progress")});
        expect(requestsOf(fixture.current(), "thread/rollback")).toEqual([]);
        release();
        await pending;
        await expect(fixture.rewind()).resolves.toEqual({rewound: true});
    });
});
