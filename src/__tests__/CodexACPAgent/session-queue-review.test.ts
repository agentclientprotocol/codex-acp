import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {SESSION_QUEUE_ACTIONS, type SessionQueueNative} from "../../SessionQueue";
import type {SessionState} from "../../CodexAcpServer";
import {OPENAI_PROVIDER_ID} from "../../CodexAcpClient";
import type {ThreadReadResponse, Turn, TurnCompletedNotification} from "../../app-server/v2";

const sessionId = "session-id";
const turn = (id: string, status: Turn["status"] = "inProgress"): Turn => ({
    id, status, items: [], itemsView: "notLoaded", error: null,
    startedAt: null, completedAt: null, durationMs: null,
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}

async function setup() {
    const f = createCodexMockTestFixture();
    const agent = f.getCodexAcpAgent();
    const client = f.getCodexAcpClient();
    const native = f.getCodexAppServerClient();
    client.queueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
    const state = createTestSessionState();
    (agent as unknown as {sessions: Map<string, SessionState>}).sessions.set(sessionId, state);
    const submission = {id: "q", clientUserMessageId: "client", input: []};
    const queue = {
        list: vi.fn<SessionQueueNative["list"]>().mockResolvedValue({data: [], nextCursor: null}),
        add: vi.fn<SessionQueueNative["add"]>().mockResolvedValue({queuedSubmission: submission}),
        update: vi.fn<SessionQueueNative["update"]>().mockResolvedValue({queuedSubmission: submission}),
        delete: vi.fn<SessionQueueNative["delete"]>().mockResolvedValue({deleted: true}),
        reorder: vi.fn<SessionQueueNative["reorder"]>().mockResolvedValue({}),
        start: vi.fn<SessionQueueNative["start"]>().mockResolvedValue({turn: turn("queued")}),
    } satisfies SessionQueueNative;
    vi.spyOn(native, "queueNative").mockReturnValue(queue);
    // Prompt admission only consumes the status from this metadata read.
    vi.spyOn(native, "threadRead").mockResolvedValue({
        thread: {id: sessionId, status: {type: "idle"}},
    } as ThreadReadResponse);
    const request = (action: string, extra: Record<string, unknown> = {}) =>
        agent.manageSessionQueue({sessionId, action, ...extra});
    await request("list");
    const emit = async (method: string, params: object = {}) => {
        f.sendServerNotification({method, params: {threadId: sessionId, ...params}});
        await client.waitForSessionNotifications(sessionId);
    };
    const notifications = (method: string) => f.getAcpConnectionEvents([])
        .filter(event => event.method === "notify" && event.args[0] === method)
        .map(event => event.args[1]);
    const approval = (turnId: string) => f.sendServerRequest("item/commandExecution/requestApproval", {
        threadId: sessionId, turnId, itemId: `cmd-${turnId}`, approvalId: null,
        kind: "command", startedAtMs: 0, environmentId: null,
        command: `echo ${turnId}`, cwd: "/test/cwd", reason: null,
        availableDecisions: ["accept", "decline"],
    });
    return {f, agent, client, native, state, queue, request, emit, notifications, approval};
}

describe("native queue review regressions", () => {
    it("invalidates the provider on an unanswered durable queue write and refuses a late retry", async () => {
        const {agent, queue, request} = await setup();
        vi.useFakeTimers();
        try {
            const pending = deferred<Awaited<ReturnType<SessionQueueNative["add"]>>>();
            queue.add.mockReturnValueOnce(pending.promise);
            const result = request("add", {input: [], clientUserMessageId: "client"});
            const failed = expect(result).rejects.toThrow("timed out");
            await vi.advanceTimersByTimeAsync(30_000);
            await failed;
            pending.resolve({queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}});
            await Promise.resolve();
            await expect(request("add", {input: [], clientUserMessageId: "client"})).rejects.toThrow();
            await expect(agent.prompt({sessionId, prompt: []})).rejects.toThrow();
            expect(queue.add).toHaveBeenCalledOnce();
            await expect(agent.closeSession({sessionId})).resolves.toEqual({});
        } finally { vi.useRealTimers(); }
    });
    it.each(["set", "disable"] as const)("rejects provider %s before changing configuration during a queued turn", async action => {
        const {agent, client, emit} = await setup();
        client.setProvider({
            providerId: OPENAI_PROVIDER_ID, apiType: "openai", baseUrl: "https://original.example/v1",
        });
        const before = agent.listProviders({});
        await emit("turn/started", {turn: turn("queued")});
        try {
            const changing = action === "set"
                ? agent.setProvider({
                    providerId: OPENAI_PROVIDER_ID, apiType: "openai", baseUrl: "https://replacement.example/v1",
                })
                : agent.disableProvider({providerId: OPENAI_PROVIDER_ID});
            await expect(changing).rejects.toMatchObject({code: -32600});
            expect(agent.listProviders({})).toEqual(before);
        } finally {
            await emit("turn/completed", {turn: turn("queued", "completed")});
        }
    });

    it.each(["local command", "failed native start"] as const)(
        "owns queued work after a prompt exits through %s without turn/completed",
        async exit => {
            const {f, agent, native, request, emit, notifications, client, state} = await setup();
            const start = vi.spyOn(native, "turnStart");
            if (exit === "local command") {
                // Missing rename arguments only produce a local usage message.
                await expect(agent.prompt({sessionId, prompt: [{type: "text", text: "/rename"}]}))
                    .resolves.toMatchObject({stopReason: "end_turn"});
                expect(start).not.toHaveBeenCalled();
            } else {
                start.mockRejectedValueOnce(new Error("native start rejected"));
                await expect(agent.prompt({sessionId, prompt: [{type: "text", text: "hello"}]}))
                    .rejects.toThrow("native start rejected");
                expect(start).toHaveBeenCalledOnce();
            }

            await request("add", {input: [], clientUserMessageId: "client"});
            await emit("turn/started", {turn: turn("queued")});
            await emit("item/agentMessage/delta", {turnId: "queued", itemId: "answer", delta: "queued output"});
            try {
                expect(notifications("_session/queue/turn")).toEqual([{sessionId, turn: turn("queued")}]);
                expect(state.currentTurnId).toBe("queued");
                expect(f.getAcpConnectionEvents([]).filter(event => event.method === "sessionUpdate"
                    && event.args[0].update.content?.text === "queued output")).toHaveLength(1);
                await expect(agent.prompt({sessionId, prompt: []})).rejects.toMatchObject({
                    data: expect.stringContaining("queued turn"),
                });
                const interrupt = vi.spyOn(client, "turnInterrupt").mockResolvedValue();
                await agent.cancel({sessionId});
                expect(interrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: "queued"});
            } finally {
                await emit("turn/completed", {turn: turn("queued", "interrupted")});
            }
            expect(notifications("_session/queue/turn")).toEqual([
                {sessionId, turn: turn("queued")},
                {sessionId, turn: turn("queued", "interrupted")},
            ]);
        },
    );

    it.each(["add", "start"] as const)("remembers cancel while queue %s is awaiting turn/started", async action => {
        const {agent, client, queue, request, emit, state} = await setup();
        const dispatched = deferred<void>();
        const release = deferred<void>();
        const interrupt = vi.spyOn(client, "turnInterrupt").mockResolvedValue();
        if (action === "add") {
            queue.add.mockImplementationOnce(async () => {
                dispatched.resolve();
                await release.promise;
                await emit("turn/started", {turn: turn("queued")});
                return {queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}};
            });
        } else {
            queue.start.mockImplementationOnce(async () => {
                dispatched.resolve();
                await release.promise;
                await emit("turn/started", {turn: turn("queued")});
                return {turn: turn("queued")};
            });
        }
        const pending = request(action, action === "add" ? {input: [], clientUserMessageId: "client"} : {});
        await dispatched.promise;
        try {
            expect(state.currentTurnId).toBeNull();
            await agent.cancel({sessionId});
            expect(interrupt).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await pending;
        }
        try {
            expect(interrupt).toHaveBeenCalledExactlyOnceWith({threadId: sessionId, turnId: "queued"});
        } finally {
            await emit("turn/completed", {turn: turn("queued", "interrupted")});
        }
    });

    it("rejects an approval delayed across completion and successor start without rejecting the successor", async () => {
        const {f, client, emit, approval} = await setup();
        await emit("turn/started", {turn: turn("old")});
        f.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
        const waiting = deferred<void>();
        const release = deferred<void>();
        const drain = client.waitForSessionNotifications.bind(client);
        // Pause only the interactive request's notification barrier. Normal event delivery remains live.
        const barrier = vi.spyOn(client, "waitForSessionNotifications").mockImplementationOnce(async id => {
            waiting.resolve();
            await release.promise;
            await drain(id);
        });
        const stale = approval("old");
        await waiting.promise;
        try {
            await emit("turn/completed", {turn: turn("old", "completed")});
            await emit("turn/started", {turn: turn("new")});
        } finally {
            release.resolve();
            barrier.mockRestore();
        }
        try {
            expect(await stale).toEqual({decision: "cancel"});
            expect(f.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission")).toEqual([]);
            expect(await approval("new")).toEqual({decision: "accept"});
            expect(f.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission")).toHaveLength(1);
        } finally {
            await emit("turn/completed", {turn: turn("new", "completed")});
        }
    });

    it("publishes each queue invalidation exactly once during an ordinary active prompt", async () => {
        const {agent, native, request, queue, emit, notifications} = await setup();
        const awaitingCompletion = deferred<void>();
        const completed = deferred<TurnCompletedNotification>();
        vi.spyOn(native, "turnStart").mockImplementationOnce(async () => {
            await emit("turn/started", {turn: turn("normal")});
            return {turn: turn("normal")};
        });
        vi.spyOn(native, "awaitTurnCompleted").mockImplementationOnce(() => {
            awaitingCompletion.resolve();
            return completed.promise;
        });
        const prompt = agent.prompt({sessionId, prompt: [{type: "text", text: "normal"}]});
        await Promise.race([
            awaitingCompletion.promise,
            prompt.then(() => { throw new Error("Prompt completed before the native turn was awaited"); }),
        ]);
        queue.add.mockImplementationOnce(async () => {
            await emit("thread/queue/changed");
            return {queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}};
        });
        queue.update.mockImplementationOnce(async () => {
            await emit("thread/queue/changed");
            return {queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}};
        });
        queue.reorder.mockImplementationOnce(async () => {
            await emit("thread/queue/changed");
            return {};
        });
        try {
            await request("add", {input: [], clientUserMessageId: "client"});
            expect(notifications("_session/queue/changed")).toEqual([{sessionId}]);
            await request("update", {queuedSubmissionId: "q", input: []});
            expect(notifications("_session/queue/changed")).toEqual([{sessionId}, {sessionId}]);
            await request("reorder", {queuedSubmissionIds: ["q"]});
            expect(notifications("_session/queue/changed")).toEqual([{sessionId}, {sessionId}, {sessionId}]);
            expect(notifications("_session/queue/turn")).toEqual([]);
        } finally {
            const terminal = {threadId: sessionId, turn: turn("normal", "completed")};
            await emit("turn/completed", terminal);
            completed.resolve(terminal);
            await prompt;
        }
    });
});
