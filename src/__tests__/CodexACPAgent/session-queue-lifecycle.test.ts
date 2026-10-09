import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {SESSION_QUEUE_ACTIONS, type SessionQueueNative} from "../../SessionQueue";
import type {SessionState} from "../../CodexAcpServer";
import type {Turn} from "../../app-server/v2";

const sessionId = "session-id";
const turn = (id: string, status: Turn["status"] = "inProgress"): Turn => ({
    id, status, items: [], itemsView: "notLoaded", error: null, startedAt: null, completedAt: null, durationMs: null,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve}; }
async function setup() {
    const f = createCodexMockTestFixture();
    const agent = f.getCodexAcpAgent(), client = f.getCodexAcpClient(), native = f.getCodexAppServerClient();
    client.queueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
    const state = createTestSessionState();
    (agent as unknown as {sessions: Map<string, SessionState>}).sessions.set(sessionId, state);
    const queue = {
        list: vi.fn().mockResolvedValue({data: [], nextCursor: null}),
        add: vi.fn().mockResolvedValue({queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}}),
        update: vi.fn().mockResolvedValue({queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}}),
        delete: vi.fn().mockResolvedValue({deleted: true}), reorder: vi.fn().mockResolvedValue({}),
        start: vi.fn().mockResolvedValue({turn: turn("queued")}),
    } satisfies SessionQueueNative;
    vi.spyOn(native, "queueNative").mockReturnValue(queue);
    vi.spyOn(native, "threadRead").mockResolvedValue({thread: {status: {type: "idle"}}} as never);
    const request = (action: string, extra = {}) => agent.manageSessionQueue({sessionId, action, ...extra});
    await request("list");
    const emit = async (method: string, params: object) => {
        f.sendServerNotification({method, params: {threadId: sessionId, ...params}});
        await client.waitForSessionNotifications(sessionId);
    };
    return {f, agent, client, native, state, queue, request, emit};
}

describe("native queue ownership", () => {
    it("keeps session-scoped updates observable before and after autonomous turns", async () => {
        const {state, emit} = await setup();
        await emit("thread/name/updated", {threadName: "before queue"});
        expect(state.sessionTitle).toBe("before queue");
        await emit("turn/started", {turn: turn("queued")});
        await emit("turn/completed", {turn: turn("queued", "completed")});
        await emit("thread/name/updated", {threadName: "after queue"});
        expect(state.sessionTitle).toBe("after queue");
    });
    it("attaches before idle add, publishes output and terminal events after the RPC returned", async () => {
        const {f, state, queue, request, emit, agent} = await setup();
        queue.add.mockImplementationOnce(async () => {
            await emit("turn/started", {turn: turn("queued")});
            return {queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}};
        });
        await request("add", {input: [{type: "text", text: "hello"}], clientUserMessageId: "client"});
        expect(state.currentTurnId).toBe("queued");
        await expect(agent.prompt({sessionId, prompt: []})).rejects.toMatchObject({data: expect.stringContaining("queued turn")});
        await emit("item/agentMessage/delta", {turnId: "queued", itemId: "answer", delta: "queue answer"});
        await emit("turn/completed", {turn: turn("queued", "completed")});
        expect(state.currentTurnId).toBeNull();
        const events = f.getAcpConnectionEvents([]);
        expect(JSON.stringify(events)).toContain("queue answer");
        expect(events.filter(e => e.args[0] === "_session/queue/turn").map(e => (e.args[1] as any).turn.status)).toEqual(["inProgress", "completed"]);
    });

    it("hands automatic successors off without old prompt cleanup clearing their turn", async () => {
        const {f, agent, native, client, state, emit, request} = await setup();
        const completed = deferred<any>();
        vi.spyOn(native, "turnStart").mockImplementation(async () => {
            await emit("turn/started", {turn: turn("normal")}); return {turn: turn("normal")};
        });
        vi.spyOn(native, "awaitTurnCompleted").mockReturnValue(completed.promise);
        const prompt = agent.prompt({sessionId, prompt: [{type: "text", text: "normal"}]});
        await vi.waitFor(() => expect(state.currentTurnId).toBe("normal"));
        await request("add", {input: [], clientUserMessageId: "client"});
        await emit("turn/completed", {turn: turn("normal", "completed")});
        await emit("turn/started", {turn: turn("successor")});
        completed.resolve({threadId: sessionId, turn: turn("normal", "completed")});
        await prompt;
        expect(state.currentTurnId).toBe("successor");
        await emit("item/agentMessage/delta", {turnId: "successor", itemId: "answer", delta: "still alive"});
        expect(JSON.stringify(f.getAcpConnectionEvents([]))).toContain("still alive");
        const interrupt = vi.spyOn(client, "turnInterrupt").mockResolvedValue();
        await agent.cancel({sessionId});
        expect(interrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: "successor"});
        await emit("turn/completed", {turn: turn("successor", "interrupted")});
    });

    it("routes queue approval through a fresh non-aborted context", async () => {
        const {f, emit} = await setup();
        await emit("turn/started", {turn: turn("q1")});
        await emit("turn/completed", {turn: turn("q1", "interrupted")});
        await emit("turn/started", {turn: turn("q2")});
        f.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
        const response = await f.sendServerRequest("item/commandExecution/requestApproval", {
            threadId: sessionId, turnId: "q2", itemId: "cmd", approvalId: null,
            command: "echo queue", cwd: "/test/cwd", reason: null, availableDecisions: ["accept", "decline"],
        });
        expect(response).toEqual({decision: "accept"});
        await emit("turn/completed", {turn: turn("q2", "completed")});
    });

    it("serializes edits and does not retry uncertain mutations", async () => {
        const {agent, request, queue} = await setup();
        const gate = deferred<any>(); queue.update.mockReturnValueOnce(gate.promise);
        const updating = request("update", {queuedSubmissionId: "q", input: []});
        await vi.waitFor(() => expect(queue.update).toHaveBeenCalledOnce());
        await expect(request("reorder", {queuedSubmissionIds: ["q"]})).rejects.toThrow();
        await expect(agent.closeSession({sessionId})).rejects.toThrow();
        gate.resolve({queuedSubmission: {id: "q", clientUserMessageId: "client", input: []}}); await updating;
        queue.add.mockRejectedValueOnce(new Error("connection lost after commit"));
        await expect(request("add", {input: [], clientUserMessageId: "client"})).rejects.toThrow("connection lost");
        await expect(request("add", {input: [], clientUserMessageId: "client"})).rejects.toThrow();
        expect(queue.add).toHaveBeenCalledOnce();
    });

    it("manages persistent entries while unloaded without resuming or executing them", async () => {
        const {agent, client, native, request, queue} = await setup();
        await agent.closeSession({sessionId});
        vi.mocked(native.threadRead).mockResolvedValue({thread: {status: {type: "notLoaded"}}} as never);
        const resume = vi.spyOn(client, "resumeSession");
        await request("add", {input: [], clientUserMessageId: "client"});
        await request("update", {queuedSubmissionId: "q", input: []});
        await request("reorder", {queuedSubmissionIds: ["q"]});
        await request("delete", {queuedSubmissionId: "q"});
        expect(queue.add).toHaveBeenCalledOnce(); expect(resume).not.toHaveBeenCalled();
        await expect(request("start")).rejects.toThrow();
        expect(queue.start).not.toHaveBeenCalled();
    });
});
