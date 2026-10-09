import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {ACPSessionConnection, type AcpClientConnection} from "../../ACPSessionConnection";
import type {SessionState} from "../../CodexAcpServer";
import {SESSION_QUEUE_ACTIONS, type SessionQueueNative} from "../../SessionQueue";
import {CodexSubagentEventRouter} from "../../subagents/CodexSubagentEventRouter";
import type {ThreadItem, ThreadReadResponse, Turn, TurnCompletedNotification} from "../../app-server/v2";

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

async function setup(supportsSubagents = true) {
    const f = createCodexMockTestFixture();
    const agent = f.getCodexAcpAgent();
    const client = f.getCodexAcpClient();
    const native = f.getCodexAppServerClient();
    // The shared fixture ignores request cancellation. Match the real ACP boundary
    // so a retired child's aborted context cannot accidentally accept a permission.
    const connection = f.getAcpConnection();
    const abortAware = new Proxy(connection, {
        get(target, property) {
            if (property !== "request") return Reflect.get(target, property);
            return (...args: Parameters<AcpClientConnection["request"]>) => {
                if (args[2]?.cancellationSignal?.aborted) return Promise.reject(new Error("Permission context aborted"));
                return Reflect.get(target, property)(...args);
            };
        },
    });
    (agent as unknown as {connection: AcpClientConnection}).connection = abortAware;
    await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {_meta: {jetbrains: {air: {
            version: 1, capabilities: supportsSubagents ? ["nativeSubagentSessions"] : [],
        }}}},
    });
    client.queueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
    const state = createTestSessionState();
    state.subagents = new CodexSubagentEventRouter(
        sessionId, supportsSubagents, new ACPSessionConnection(f.getAcpConnection(), sessionId),
        id => state.toolCallReports.releaseOpen(id),
    );
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
    vi.spyOn(native, "threadRead").mockResolvedValue({thread: {id: sessionId, status: {type: "idle"}}} as ThreadReadResponse);
    await agent.manageSessionQueue({sessionId, action: "list"});
    f.clearAcpConnectionDump();
    f.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
    const emit = async (method: string, params: object, threadId = sessionId) => {
        f.sendServerNotification({method, params: {threadId, ...params}});
        await client.waitForSessionNotifications(sessionId);
    };
    const spawn = async (parentTurn: string, childId: string) => {
        const item: ThreadItem = {
            type: "collabAgentToolCall", id: `spawn-${childId}`, tool: "spawnAgent", status: "completed",
            senderThreadId: sessionId, receiverThreadIds: [childId], prompt: "Child task",
            model: null, reasoningEffort: null, agentsStates: {[childId]: {status: "running", message: null}},
        };
        await emit("item/completed", {turnId: parentTurn, completedAtMs: 0, item});
        await emit("item/started", {
            turnId: parentTurn, startedAtMs: 0,
            item: {type: "subAgentActivity", id: `activity-${childId}`, kind: "started",
                agentThreadId: childId, agentPath: `/root/${childId}`} satisfies ThreadItem,
        });
        await emit("turn/started", {turn: turn(`turn-${childId}`)}, childId);
    };
    const approval = (childId: string, itemId: string, turnId = `turn-${childId}`) => f.sendServerRequest("item/commandExecution/requestApproval", {
        threadId: childId, turnId, itemId, approvalId: null,
        kind: "command", startedAtMs: 0, environmentId: null,
        command: `echo ${itemId}`, cwd: "/test/cwd", availableDecisions: ["accept", "decline"],
    });
    const updates = () => f.getAcpConnectionEvents([]).filter(event => event.method === "sessionUpdate").map(event => event.args[0]);
    const childTerminals = (id: string) => updates().filter(event => event.update.sessionUpdate === "subagent_state_update"
        && event.update.subagentSessionId === id).map(event => event.update.state);
    const startPrompt = async () => {
        const entered = deferred<void>();
        const completed = deferred<TurnCompletedNotification>();
        vi.spyOn(native, "turnStart").mockImplementationOnce(async () => {
            await emit("turn/started", {turn: turn("normal")});
            return {turn: turn("normal")};
        });
        vi.spyOn(native, "awaitTurnCompleted").mockImplementationOnce(() => {
            entered.resolve();
            return completed.promise;
        });
        let settled = false;
        const result = agent.prompt({sessionId, prompt: [{type: "text", text: "normal"}]}).then(
            response => { settled = true; return {response}; },
            error => { settled = true; return {error}; },
        );
        await Promise.race([entered.promise, result.then(() => { throw new Error("Prompt ended before native completion wait"); })]);
        return {completed, result, settled: () => settled};
    };
    return {f, agent, client, state, emit, spawn, approval, updates, childTerminals, startPrompt};
}

describe("native queue child ownership", () => {
    it("routes a reused child thread to the queued turn that sends its new input", async () => {
        const h = await setup();
        await h.emit("turn/started", {turn: turn("first")});
        await h.spawn("first", "reused");
        await h.emit("turn/completed", {turn: turn("turn-reused", "completed")}, "reused");
        await h.emit("turn/completed", {turn: turn("first", "completed")});
        await checkpoint();
        await h.emit("turn/started", {turn: turn("second")});
        await h.emit("item/completed", {turnId: "second", completedAtMs: 0, item: {
            type: "collabAgentToolCall", id: "reuse", tool: "sendInput", status: "completed",
            senderThreadId: sessionId, receiverThreadIds: ["reused"], prompt: "Follow-up",
            model: null, reasoningEffort: null, agentsStates: {reused: {status: "running", message: null}},
        } satisfies ThreadItem});
        await h.emit("item/started", {turnId: "second", startedAtMs: 0, item: {
            type: "subAgentActivity", id: "reuse-activity", kind: "started",
            agentThreadId: "reused", agentPath: "/root/reused",
        } satisfies ThreadItem});
        await h.emit("turn/started", {turn: turn("turn-reused-2")}, "reused");
        try {
            expect(await h.approval("reused", "new-input", "turn-reused-2")).toEqual({decision: "accept"});
            await h.emit("item/agentMessage/delta", {
                turnId: "turn-reused-2", itemId: "reused-answer", delta: "follow-up output",
            }, "reused");
            expect(h.updates().filter(event => event.update.content?.text === "follow-up output")).toHaveLength(1);
        } finally {
            await h.emit("turn/completed", {turn: turn("turn-reused-2", "completed")}, "reused");
            await h.emit("turn/completed", {turn: turn("second", "interrupted")});
        }
    });

    it.each([
        {root: "queued", visible: true}, {root: "queued", visible: false},
        {root: "normal", visible: true}, {root: "normal", visible: false},
    ] as const)("keeps $root child approvals alive after root completion and queue handoff (visible=$visible)", async ({root, visible}) => {
        const h = await setup(visible);
        const prompt = root === "normal" ? await h.startPrompt() : undefined;
        if (root === "queued") await h.emit("turn/started", {turn: turn(root)});
        await h.spawn(root, "child-a");
        const terminal = {threadId: sessionId, turn: turn(root, "completed")};
        await h.emit("turn/completed", terminal);
        let successorStarted = false;
        try {
            expect(await h.approval("child-a", "after-parent")).toEqual({decision: "accept"});
            await h.emit("turn/started", {turn: turn("successor")});
            successorStarted = true;
            expect(await h.approval("child-a", "after-successor")).toEqual({decision: "accept"});
            const requests = h.f.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission");
            expect(requests.map(event => event.args[0].sessionId)).toEqual([
                visible ? "child-a" : sessionId, visible ? "child-a" : sessionId,
            ]);
            expect(h.childTerminals("child-a")).toEqual([]);
            await h.emit("turn/completed", {turn: turn("turn-child-a", "completed")}, "child-a");
            expect(await h.approval("child-a", "stale-child")).toEqual({decision: "cancel"});
            expect(h.f.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission")).toHaveLength(2);
            if (visible) expect(h.childTerminals("child-a")).toEqual(["completed"]);
        } finally {
            await h.emit("turn/completed", {turn: turn("turn-child-a", "completed")}, "child-a");
            if (successorStarted) await h.emit("turn/completed", {turn: turn("successor", "completed")});
            prompt?.completed.resolve(terminal);
            await prompt?.result;
        }
    });

    it.each(["completed", "failed"] as const)("does not let a %s ordinary prompt wait on or finalize successor children", async status => {
        const h = await setup();
        const prompt = await h.startPrompt();
        const terminal = {threadId: sessionId, turn: turn("normal", status)};
        await h.emit("turn/completed", terminal);
        await h.emit("turn/started", {turn: turn("successor")});
        await h.spawn("successor", "child-b");
        expect(h.updates().filter(event => event.update.sessionUpdate === "subagent_spawned"
            && event.update.subagentSessionId === "child-b")).toHaveLength(1);
        prompt.completed.resolve(terminal);
        try {
            await checkpoint();
            // B's child stays open until its own native terminal event, even if A failed.
            expect(h.childTerminals("child-b")).toEqual([]);
            expect(prompt.settled()).toBe(true);
            expect(h.state.currentTurnId).toBe("successor");
            expect(await h.approval("child-b", "survived-cleanup")).toEqual({decision: "accept"});
            await h.emit("item/agentMessage/delta", {
                turnId: "turn-child-b", itemId: "answer-b", delta: "child survived",
            }, "child-b");
            expect(h.updates().filter(event => event.sessionId === "child-b"
                && event.update.content?.text === "child survived")).toHaveLength(1);
        } finally {
            await h.emit("turn/completed", {turn: turn("turn-child-b", "completed")}, "child-b");
            await h.emit("turn/completed", {turn: turn("successor", "completed")});
            await prompt.result;
        }
        expect(h.childTerminals("child-b")).toEqual(["completed"]);
    });
});
