import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {SESSION_QUEUE_ACTIONS, type SessionQueueNative} from "../../SessionQueue";
import type {CodexAcpServer, SessionState} from "../../CodexAcpServer";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import type {ThreadItem, ThreadReadResponse, Turn} from "../../app-server/v2";

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
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

async function setup(attach = true) {
    const f = createCodexMockTestFixture();
    const agent = f.getCodexAcpAgent();
    const client = f.getCodexAcpClient();
    const native = f.getCodexAppServerClient();
    const connection = f.getAcpConnection();
    // Model the real ACP cancellation boundary, absent from the shared mock.
    (agent as unknown as {connection: AcpClientConnection}).connection = new Proxy(connection, {
        get(target, property) {
            if (property !== "request") return Reflect.get(target, property);
            return (...args: Parameters<AcpClientConnection["request"]>) => {
                if (args[2]?.cancellationSignal?.aborted) return Promise.reject(new Error("Permission context aborted"));
                return Reflect.get(target, property)(...args);
            };
        },
    });
    client.queueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
    const state = createTestSessionState();
    const boundaries = agent as unknown as {
        sessions: Map<string, SessionState>;
        installSessionState(state: SessionState): void;
    };
    boundaries.sessions.set(sessionId, state);
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
    vi.spyOn(native, "threadRead").mockResolvedValue({thread: {id: sessionId, status: {type: "idle"}}} as ThreadReadResponse);
    const send = (method: string, params: object = {}, threadId = sessionId) =>
        f.sendServerNotification({method, params: {threadId, ...params}});
    const emit = async (method: string, params: object = {}, threadId = sessionId) => {
        send(method, params, threadId);
        await client.waitForSessionNotifications(sessionId);
    };
    if (attach) await agent.manageSessionQueue({sessionId, action: "list"});
    f.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
    const spawn = async (parent: string, parentTurn: string, child: string) => {
        await emit("item/completed", {turnId: parentTurn, completedAtMs: 0, item: {
            type: "collabAgentToolCall", id: `spawn-${child}`, tool: "spawnAgent", status: "completed",
            senderThreadId: parent, receiverThreadIds: [child], prompt: "child task",
            model: null, reasoningEffort: null, agentsStates: {[child]: {status: "running", message: null}},
        } satisfies ThreadItem}, parent);
        await emit("turn/started", {turn: turn(`turn-${child}`)}, child);
    };
    const approval = (child: string) => f.sendServerRequest("item/commandExecution/requestApproval", {
        threadId: child, turnId: `turn-${child}`, itemId: `cmd-${child}`, approvalId: null,
        kind: "command", startedAtMs: 0, environmentId: null,
        command: "echo test", cwd: "/test/cwd", availableDecisions: ["accept", "decline"],
    });
    return {f, agent, client, native, state, boundaries, queue, send, emit, spawn, approval};
}

describe("independent maintainer queue regressions", () => {
    it("retries cancellation while an autonomous turn is not registered as interruptible yet", async () => {
        const h = await setup();
        await h.emit("turn/started", {turn: turn("queued")});
        const interrupt = vi.spyOn(h.client, "turnInterrupt")
            .mockRejectedValueOnce(new Error("no active turn to interrupt"))
            .mockResolvedValue();
        try {
            await h.agent.cancel({sessionId});
            expect(interrupt).toHaveBeenCalledTimes(2);
        } finally {
            await h.emit("turn/completed", {turn: turn("queued", "interrupted")});
        }
    });

    it("preserves cancellation while the first queue subscription is being installed", async () => {
        const h = await setup(false);
        const entered = deferred<void>();
        const release = deferred<void>();
        const subscribe = h.client.subscribeToQueueEvents.bind(h.client);
        vi.spyOn(h.client, "subscribeToQueueEvents").mockImplementationOnce(async (...args) => {
            await subscribe(...args);
            entered.resolve();
            await release.promise;
        });
        const interrupt = vi.spyOn(h.client, "turnInterrupt").mockResolvedValue();
        const add = h.agent.manageSessionQueue({sessionId, action: "add", input: [], clientUserMessageId: "client"});
        await entered.promise;
        await h.agent.cancel({sessionId});
        release.resolve();
        await add;
        try {
            await h.emit("turn/started", {turn: turn("queued")});
            expect(interrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: "queued"});
        } finally {
            await h.emit("turn/completed", {turn: turn("queued", "interrupted")});
        }
    });

    it("does not replay buffered notifications from the old subscription into a replacement owner", async () => {
        const h = await setup();
        const entered = deferred<void>();
        const release = deferred<void>();
        const connection = h.f.getAcpConnection();
        const notify = connection.notify.bind(connection);
        let block = true;
        const original = (h.agent as unknown as {connection: AcpClientConnection}).connection;
        (h.agent as unknown as {connection: AcpClientConnection}).connection = new Proxy(original, {
            get(target, property) {
                if (property !== "notify") return Reflect.get(target, property);
                return async (...args: Parameters<AcpClientConnection["notify"]>) => {
                    if (block) { block = false; entered.resolve(); await release.promise; }
                    return notify(...args);
                };
            },
        });
        h.send("thread/queue/changed");
        await entered.promise;
        h.send("turn/started", {turn: turn("old-subscription-turn")});
        const fresh = createTestSessionState();
        const metadata: Awaited<ReturnType<CodexAcpServer["getOrCreateSession"]>> = [
            sessionId, {currentModelId: fresh.currentModelId, availableModels: []}, fresh.agentMode.toSessionModeState(false),
        ];
        vi.spyOn(h.agent, "getOrCreateSession").mockImplementationOnce(async () => {
            h.boundaries.installSessionState(fresh);
            return metadata;
        });
        try {
            await h.agent.closeSession({sessionId});
            await h.agent.resumeSession({sessionId, cwd: "/test/cwd", mcpServers: []});
        } finally {
            release.resolve();
        }
        try {
            await h.client.waitForSessionNotifications(sessionId);
            expect(fresh.currentTurnId).toBeNull();
        } finally {
            await h.emit("turn/completed", {turn: turn("old-subscription-turn", "interrupted")});
        }
    });

    it("keeps hidden grandchildren alive when they are discovered after root completion", async () => {
        const h = await setup();
        await h.emit("turn/started", {turn: turn("queued")});
        await h.spawn(sessionId, "queued", "child");
        await h.emit("turn/completed", {turn: turn("queued", "completed")});
        await checkpoint();
        await h.spawn("child", "turn-child", "grandchild");
        expect(await h.approval("grandchild")).toEqual({decision: "accept"});
        await h.emit("turn/completed", {turn: turn("turn-child", "completed")}, "child");
        await checkpoint();
        try {
            expect(await h.approval("grandchild")).toEqual({decision: "accept"});
        } finally {
            await h.emit("turn/completed", {turn: turn("turn-grandchild", "completed")}, "grandchild");
        }
    });

    it("interrupts early autonomous execution when a cold load fails during history replay", async () => {
        const h = await setup(false);
        h.boundaries.sessions.clear();
        type HistoryBoundary = {
            getOrCreateSessionWithHistory: (...args: unknown[]) => Promise<unknown>;
            streamThreadHistory: (...args: unknown[]) => Promise<void>;
        };
        const history = h.agent as unknown as HistoryBoundary;
        const interrupt = vi.spyOn(h.client, "turnInterrupt").mockResolvedValue();
        vi.spyOn(history, "getOrCreateSessionWithHistory").mockImplementationOnce(async () => {
            h.send("turn/started", {turn: turn("early")});
            h.boundaries.installSessionState(h.state);
            return {sessionId, modelState: {currentModelId: h.state.currentModelId, availableModels: []},
                modeState: h.state.agentMode.toSessionModeState(false), thread: {id: sessionId},
                history: (async function* () {})()};
        });
        vi.spyOn(history, "streamThreadHistory").mockRejectedValueOnce(new Error("history read failed"));
        await expect(h.agent.loadSession({sessionId, cwd: "/test/cwd", mcpServers: []})).rejects.toThrow("history read failed");
        await h.client.waitForSessionNotifications(sessionId);
        expect(interrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: "early"});
    });

    it("rejects a late old-turn approval after a child thread is reused", async () => {
        const h = await setup();
        await h.emit("turn/started", {turn: turn("first")});
        await h.spawn(sessionId, "first", "reused");
        await h.emit("turn/completed", {turn: turn("turn-reused", "completed")}, "reused");
        await h.emit("turn/completed", {turn: turn("first", "completed")});
        await checkpoint();
        await h.emit("turn/started", {turn: turn("second")});
        await h.emit("item/completed", {turnId: "second", completedAtMs: 0, item: {
            type: "collabAgentToolCall", id: "reuse", tool: "sendInput", status: "completed",
            senderThreadId: sessionId, receiverThreadIds: ["reused"], prompt: "follow-up",
            model: null, reasoningEffort: null, agentsStates: {reused: {status: "running", message: null}},
        } satisfies ThreadItem});
        await h.emit("turn/started", {turn: turn("turn-reused-new")}, "reused");
        try {
            // approval() deliberately sends the previous turn-reused id.
            expect(await h.approval("reused")).toEqual({decision: "cancel"});
        } finally {
            await h.emit("turn/completed", {turn: turn("turn-reused-new", "completed")}, "reused");
            await h.emit("turn/completed", {turn: turn("second", "completed")});
        }
    });

    it("does not dispatch an add cancelled while unloaded-thread preflight is pending", async () => {
        const h = await setup(false);
        h.boundaries.sessions.clear();
        const entered = deferred<void>();
        const release = deferred<void>();
        vi.mocked(h.native.threadRead).mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return {thread: {id: sessionId, status: {type: "notLoaded"}}} as ThreadReadResponse;
        });
        const abort = new AbortController();
        const add = h.agent.manageSessionQueue({sessionId, action: "add", input: [], clientUserMessageId: "client"}, abort.signal);
        const result = add.then(value => ({value}), error => ({error}));
        await entered.promise;
        abort.abort();
        release.resolve();
        expect(await result).toHaveProperty("error");
        expect(h.queue.add).not.toHaveBeenCalled();
    });
});
