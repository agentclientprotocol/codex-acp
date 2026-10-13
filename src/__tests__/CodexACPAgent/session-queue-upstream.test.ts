import {describe, expect, it, vi} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {SESSION_QUEUE_ACTIONS} from "../../SessionQueue";
import {createRecoveryFixture, defaultAnswer, initialize, requestsOf, type RecoveryFixture} from "../app-server-recovery/recovery-fixture";

const sessionId = "thread-new";
const add = {sessionId, action: "add", input: [{type: "text", text: "queued"}], clientUserMessageId: "client-1"};
const queued = {queuedSubmission: {id: "q-1", input: add.input, clientUserMessageId: add.clientUserMessageId}};
const turn = (id = "queued-turn", status = "inProgress") => ({id, status, items: [], itemsView: "notLoaded", error: null,
    startedAt: null, completedAt: null, durationMs: null});
const capability = {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}};
const writes = (f: RecoveryFixture, action: string) => f.servers.flatMap(s => requestsOf(s, `thread/queue/${action}`))
    .filter(p => (p as {threadId?: string}).threadId);

async function setup(open = true) {
    const f = createRecoveryFixture();
    f.answers.set("initialize", () => ({userAgent: "codex/0.160.1 (fixture)", codexHome: "/codex-home"}));
    for (const action of SESSION_QUEUE_ACTIONS) {
        f.answers.set(`thread/queue/${action}`, params => {
            if (!(params as {threadId?: string}).threadId) return new ResponseError(-32600, "Invalid request: missing field `threadId`");
            if (action === "list") return {data: [], nextCursor: null};
            if (action === "start") return {turn: turn()};
            if (action === "delete") return {deleted: true};
            return action === "reorder" ? {} : queued;
        });
    }
    f.answers.set("thread/read", params => ({thread: {
        ...(defaultAnswer("thread/resume", params) as {thread: object}).thread,
        path: "/codex-home/sessions/fixture.jsonl", status: {type: open ? "idle" : "notLoaded"},
    }}));
    await initialize(f, true, capability);
    if (open) await f.agent.newSession({cwd: "/work", mcpServers: []});
    return f;
}

const indexMutation = (f: RecoveryFixture, action: string) => action === "rename"
    ? f.agent.sessionIndex.rename({sessionId, title: "Renamed"})
    : f.agent.sessionIndex.setArchived({sessionId}, action === "archive");

describe("native queue with upstream recovery and session index", () => {
    it("restarts and reprobes before reading a cold queue without resuming it", async () => {
        const f = await setup(false);
        await f.kill();
        await expect(f.agent.manageSessionQueue({sessionId, action: "list"})).resolves.toMatchObject({status: "ok"});
        expect(f.servers).toHaveLength(2);
        expect(writes(f, "list")).toHaveLength(1);
        expect(requestsOf(f.current(), "thread/resume")).toEqual([]);
        for (const action of SESSION_QUEUE_ACTIONS) expect(requestsOf(f.current(), `thread/queue/${action}`)).toContainEqual({});
    });

    it("fails closed for a stale loaded session, then accepts one write after explicit load", async () => {
        const f = await setup();
        await f.kill();
        await expect(f.agent.manageSessionQueue(add)).rejects.toMatchObject({code: -32600, data: expect.stringContaining("Load the session")});
        expect(writes(f, "add")).toEqual([]);
        expect(requestsOf(f.current(), "thread/resume")).toEqual([]);
        await f.agent.loadSession({sessionId, cwd: "/work", mcpServers: []});
        await expect(f.agent.manageSessionQueue(add)).resolves.toMatchObject({status: "ok"});
        expect(writes(f, "add")).toHaveLength(1);
    });

    it("never replays a write whose ACK was lost, even when another request restarts the server", async () => {
        const f = await setup();
        f.answers.set("thread/queue/add", p => (p as {threadId?: string}).threadId
            ? undefined : new ResponseError(-32600, "Invalid request: missing field `threadId`"));
        const pending = f.agent.manageSessionQueue(add);
        const rejected = expect(pending).rejects.toBeDefined();
        await vi.waitFor(() => expect(writes(f, "add")).toHaveLength(1));
        await f.kill();
        await rejected;
        await f.agent.listSessions({});
        await expect(f.agent.manageSessionQueue(add)).rejects.toMatchObject({code: -32600, data: expect.stringContaining("reconcile")});
        expect(writes(f, "add")).toHaveLength(1);
        expect(requestsOf(f.current(), "thread/resume")).toEqual([]);
    });

    it("rechecks support on the replacement rather than using the dead server's capability", async () => {
        const f = await setup(false);
        await f.kill();
        f.answers.set("initialize", () => ({userAgent: "codex/0.159.0 (fixture)", codexHome: "/codex-home"}));
        await expect(f.agent.manageSessionQueue(add)).resolves.toEqual({status: "unsupported"});
        expect(writes(f, "add")).toEqual([]);
    });

    it("requires explicit load instead of auto-dispatching persisted work during lazy prompt recovery", async () => {
        const f = await setup();
        await f.kill();
        f.answers.set("thread/queue/list", params => (params as {threadId?: string}).threadId
            ? {data: [queued.queuedSubmission], nextCursor: null}
            : new ResponseError(-32600, "Invalid request: missing field `threadId`"));
        await expect(f.agent.prompt({sessionId, prompt: [{type: "text", text: "ordinary"}]})).rejects.toBeDefined();
        expect(requestsOf(f.current(), "thread/resume")).toEqual([]);
        expect(requestsOf(f.current(), "turn/start")).toEqual([]);
        expect(writes(f, "add")).toEqual([]);
    });

    it("owns a resumed queue before metadata completes and interrupts it during cold load", async () => {
        const f = await setup();
        await f.kill();
        f.answers.set("thread/resume", (params, server) => {
            server.rpc.notify({method: "turn/started", params: {threadId: sessionId, turn: turn()}});
            return defaultAnswer("thread/resume", params);
        });
        f.answers.set("model/list", () => undefined);
        const loading = f.agent.loadSession({sessionId, cwd: "/work", mcpServers: []});
        loading.catch(() => undefined);
        await vi.waitFor(() => expect(f.servers.length === 2 && f.current().rpc.hasPending("model/list")).toBe(true));
        await f.agent.cancel({sessionId});
        expect(requestsOf(f.current(), "turn/interrupt")).toEqual([{threadId: sessionId, turnId: "queued-turn"}]);
        f.current().rpc.notify({method: "turn/completed", params: {threadId: sessionId, turn: turn("queued-turn", "interrupted")}});
        f.current().rpc.resolve("model/list", defaultAnswer("model/list", {}));
        await loading;
    });

    it("discards the crashed owner's events and publishes the resumed owner's output", async () => {
        const f = await setup();
        const previous = f.current();
        previous.rpc.notify({method: "turn/started", params: {threadId: sessionId, turn: turn("old")}});
        await f.kill();
        await f.agent.loadSession({sessionId, cwd: "/work", mcpServers: []});
        previous.rpc.notify({method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: "old", itemId: "old", delta: "stale output"}});
        f.current().rpc.notify({method: "turn/started", params: {threadId: sessionId, turn: turn("new")}});
        f.current().rpc.notify({method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: "new", itemId: "new", delta: "fresh output"}});
        await vi.waitFor(() => expect(f.updates().map(x => x.update)).toContainEqual(expect.objectContaining({content: {type: "text", text: "fresh output"}})));
        expect(f.updates().map(x => x.update)).not.toContainEqual(expect.objectContaining({content: {type: "text", text: "stale output"}}));
        f.current().rpc.notify({method: "turn/completed", params: {threadId: sessionId, turn: turn("new", "completed")}});
    });

    it("unblocks a queue request waiting for a provider replacement that crashed without replaying it", async () => {
        const f = await setup();
        f.answers.set("thread/resume", () => undefined);
        const update = f.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "http://127.0.0.1:1/v1"});
        const rejectedUpdate = expect(update).rejects.toBeDefined();
        await vi.waitFor(() => expect(f.servers.length === 2 && f.current().rpc.hasPending("thread/resume")).toBe(true));
        const queue = f.agent.manageSessionQueue(add);
        const rejectedQueue = expect(queue).rejects.toMatchObject({code: -32600, data: expect.stringContaining("Load the session")});
        await f.kill();
        await rejectedUpdate;
        await rejectedQueue;
        expect(writes(f, "add")).toEqual([]);
        expect(f.servers).toHaveLength(3);
    });

    it("lets close settle a prompt that a provider update is waiting for", async () => {
        const f = await setup();
        const prompt = f.agent.prompt({sessionId, prompt: [{type: "text", text: "ordinary"}]});
        prompt.catch(() => undefined);
        await vi.waitFor(() => expect(f.agent.getSessionState(sessionId).currentTurnId).not.toBeNull());
        const update = f.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "http://127.0.0.1:1/v1"});
        update.catch(() => undefined);
        await f.agent.closeSession({sessionId});
        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        // The queue check fails replacement closed when close wins the race;
        // it must not keep close waiting on the update that awaits this prompt.
        await expect(update).rejects.toMatchObject({code: -32600, data: `Session ${sessionId} is closing`});
        expect(requestsOf(f.current(), "turn/interrupt")).toHaveLength(1);
    });

    it.each(["archive", "unarchive", "rename"])("blocks direct index %s during a queue write", async action => {
        const f = await setup(false);
        f.answers.set("thread/queue/add", () => undefined);
        const pending = f.agent.manageSessionQueue(add);
        await vi.waitFor(() => expect(writes(f, "add")).toHaveLength(1));
        await expect(indexMutation(f, action)).rejects.toMatchObject({code: -32600, data: expect.stringContaining("Queue mutation")});
        expect(requestsOf(f.current(), "thread/archive")).toEqual([]);
        expect(requestsOf(f.current(), "thread/unarchive")).toEqual([]);
        expect(requestsOf(f.current(), "thread/name/set")).toEqual([]);
        f.current().rpc.resolve("thread/queue/add", queued);
        await pending;
    });

    it.each(["archive", "unarchive", "rename"])("blocks direct index %s until cancellation settles", async action => {
        const f = await setup();
        f.current().rpc.notify({method: "turn/started", params: {threadId: sessionId, turn: turn()}});
        f.answers.set("turn/interrupt", () => undefined);
        const cancel = f.agent.cancel({sessionId});
        await vi.waitFor(() => expect(f.current().rpc.hasPending("turn/interrupt")).toBe(true));
        await expect(indexMutation(f, action)).rejects.toMatchObject({code: -32600, data: expect.stringContaining("cancellation")});
        f.current().rpc.resolve("turn/interrupt", {});
        await cancel;
        f.current().rpc.notify({method: "turn/completed", params: {threadId: sessionId, turn: turn("queued-turn", "interrupted")}});
    });

    it("keeps a cold archive reserved through its native ACK", async () => {
        const f = await setup(false);
        f.answers.set("thread/archive", () => undefined);
        const archive = f.agent.sessionIndex.setArchived({sessionId}, true);
        await vi.waitFor(() => expect(f.current().rpc.hasPending("thread/archive")).toBe(true));
        await expect(f.agent.manageSessionQueue(add)).rejects.toMatchObject({code: -32600, data: "Session is busy"});
        expect(writes(f, "add")).toEqual([]);
        f.current().rpc.resolve("thread/archive", {});
        await archive;
    });
});
