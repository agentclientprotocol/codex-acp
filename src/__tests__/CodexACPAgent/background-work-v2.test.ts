import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import {
    commandExecutionItem, connectSession, createThread, cwd, itemCompleted, itemStarted, sessionId, turnCompleted,
    turnStarted, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const terminal = {itemId: "terminal", processId: "42", command: "sleep 12", cwd};
const terminalItem = {type: "terminal", terminalId: terminal.itemId} as const;
const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;
const childItem = {type: "subagent", sessionId: childId} as const;
const onWorker = (event: ServerNotification): ServerNotification =>
    ({...event, params: {...event.params, threadId: worker}} as ServerNotification);
const spawn = itemStarted({
    type: "subAgentActivity", id: "spawn", agentThreadId: worker, agentPath: "/root/worker",
    kind: "started", model: null, reasoningEffort: null,
});
const backgroundCount = (update: acp.SessionUpdate, size: number) =>
    acp.SessionUpdate.isStateUpdate(update) && Array.isArray(update.background) && update.background.length === size;

describe("ACP v2 background work", () => {
    let h: PromptSession;
    afterEach(() => {
        h?.connection.close();
        expectConformingV2SessionUpdates();
    });

    const scoped = (id = sessionId) => h.scopedUpdates.filter(value => value.sessionId === id).map(value => value.update as acp.SessionUpdate);
    const lastState = (id = sessionId) => scoped(id).filter(acp.SessionUpdate.isStateUpdate).at(-1);
    const list = (id = sessionId) => lastState(id)?.background;
    const flush = async () => { await h.waitForNotifications(); await h.request("session/list", {}); };
    const stop = (id = sessionId, terminalId = terminal.itemId) => h.request("terminal/cancel", {sessionId: id, terminalId});
    function startTerminal(emit: (event: ServerNotification) => void = event => h.emit(event)) {
        emit(turnStarted());
        emit(itemStarted({...commandExecutionItem(terminal.itemId), processId: terminal.processId}));
    }

    it("announces a process after its turn yields, then stops exactly that terminal without cancelling a turn", async () => {
        h = await connectSession();
        let live = [terminal, {...terminal, itemId: "other", processId: "43"}];
        const terminate = vi.fn(async ({processId}: {processId: string}) => {
            live = live.filter(entry => entry.processId !== processId);
            return {terminated: true};
        });
        h.setCodexResponse("thread/backgroundTerminals/list", async () => ({data: live, nextCursor: null}));
        h.setCodexResponse("thread/backgroundTerminals/terminate", params => terminate(params as {processId: string}));
        startTerminal();
        await flush();
        expect(list()).toEqual([]);
        await expect(stop()).rejects.toMatchObject({code: -32602});
        expect(terminate).not.toHaveBeenCalled();

        h.emit(turnCompleted());
        await flush();
        expect(lastState()).toMatchObject({state: "idle", stopReason: "end_turn",
            background: [terminalItem, {type: "terminal", terminalId: "other"}]});
        const announcements = scoped().findIndex(update => acp.SessionUpdate.isTerminalUpdate(update) && update.capabilities?.cancel != null);
        const listed = scoped().findIndex(update => backgroundCount(update, 2));
        expect(announcements).toBeGreaterThanOrEqual(0);
        expect(listed).toBeGreaterThan(announcements);
        await h.cancel();
        await flush();
        expect(terminate).not.toHaveBeenCalled();
        expect(h.turnInterruptCalls()).toEqual([]);

        h.emit(turnStarted("unrelated-turn"));
        await flush();
        const before = scoped().length;
        await expect(stop()).resolves.toEqual({});
        await flush();
        const later = scoped().slice(before);
        expect(later[0]).toMatchObject({sessionUpdate: "terminal_update", terminalId: terminal.itemId,
            exitStatus: {exitCode: null, signal: null}, capabilities: null});
        expect(lastState()).toMatchObject({state: "running", background: [{type: "terminal", terminalId: "other"}]});
        expect(later.some(update => update.sessionUpdate === "tool_call_update")).toBe(false);
        expect(terminate).toHaveBeenCalledExactlyOnceWith({threadId: sessionId, processId: terminal.processId});
        expect(h.turnInterruptCalls()).toEqual([]);
        await expect(stop()).rejects.toMatchObject({code: -32602});
    });

    it("rejects a stale terminal ID without stopping a process that reused its handle", async () => {
        h = await connectSession();
        const terminate = vi.fn(async () => ({terminated: true}));
        let live = [terminal];
        h.setCodexResponse("thread/backgroundTerminals/list", async () => ({data: live, nextCursor: null}));
        h.setCodexResponse("thread/backgroundTerminals/terminate", terminate);
        startTerminal();
        h.emit(turnCompleted());
        await flush();
        expect(list()).toEqual([terminalItem]);

        live = [{...terminal, itemId: "replacement"}];
        await expect(stop()).rejects.toMatchObject({code: -32602});
        expect(terminate).not.toHaveBeenCalled();
        await flush();
        expect(list()).toEqual([]);
    });

    it.each([undefined, {type: "start"}])("synchronizes current terminals before the resume response (replay: %j)", async replayFrom => {
        h = await connectSession();
        h.setCodexResponse("thread/backgroundTerminals/list", async () => ({data: [terminal], nextCursor: null}));
        const start = h.wireMessages.length;
        await h.request("session/resume", {sessionId, cwd, replayFrom});
        const frames = h.wireMessages.slice(start);
        const updates = frames.flatMap(frame => "method" in frame && frame.method === "session/update"
            ? [(frame.params as acp.UpdateSessionNotification).update] : []);
        const announcement = updates.findIndex(update => acp.SessionUpdate.isTerminalUpdate(update) && update.capabilities?.cancel != null);
        const listed = updates.findIndex(update => backgroundCount(update, 1));
        expect(announcement).toBeGreaterThanOrEqual(0);
        expect(listed).toBeGreaterThan(announcement);
        expect(updates[listed]).toMatchObject({state: "idle", background: [terminalItem]});
        expect(frames.at(-1)).toHaveProperty("result");
        const marker = updates.findIndex(update => update.sessionUpdate === "replay_complete");
        if (replayFrom) expect(announcement).toBeGreaterThan(marker);
        else expect(marker).toBe(-1);
    });

    it("retains a terminal on a list error and delists it only after publishing an observed exit", async () => {
        h = await connectSession();
        const listTerminals = vi.fn(async () => ({data: [terminal], nextCursor: null}));
        h.setCodexResponse("thread/backgroundTerminals/list", listTerminals);
        startTerminal();
        h.emit(turnCompleted());
        await flush();
        expect(list()).toEqual([terminalItem]);
        listTerminals.mockRejectedValueOnce(new Error("temporary list failure"));
        await h.request("session/resume", {sessionId, cwd});
        expect(list()).toEqual([terminalItem]);
        const before = scoped().length;
        h.emit(itemCompleted(commandExecutionItem(terminal.itemId, "completed")));
        await flush();
        const updates = scoped().slice(before);
        const exit = updates.findIndex(update => acp.SessionUpdate.isTerminalUpdate(update) && update.exitStatus?.exitCode === 0);
        const removed = updates.findIndex(update => backgroundCount(update, 0));
        expect(exit).toBeGreaterThanOrEqual(0);
        expect(removed).toBeGreaterThan(exit);
        expect(lastState()).toEqual({sessionUpdate: "state_update", state: "idle", background: []});
    });

    it("repairs a missed exit using the live process inventory without inventing an exit code", async () => {
        h = await connectSession();
        let live = true;
        h.setCodexResponse("thread/backgroundTerminals/list", async () => ({data: live ? [terminal] : [], nextCursor: null}));
        startTerminal();
        h.emit(turnCompleted());
        await flush();
        expect(list()).toEqual([terminalItem]);
        const before = scoped().length;
        live = false;
        await vi.waitFor(() => expect(list()).toEqual([]), {timeout: 3_000});
        expect(scoped().slice(before)).toEqual([
            {sessionUpdate: "terminal_update", terminalId: terminal.itemId, exitStatus: {exitCode: null, signal: null}, capabilities: null},
            {sessionUpdate: "state_update", state: "idle", background: []},
        ]);
    });

    it("preserves a detached child's pending approval on parent cancel and stops the child on close", async () => {
        let resolve!: (result: acp.RequestPermissionResponse) => void;
        const waiting = new Promise<acp.RequestPermissionResponse>(done => { resolve = done; });
        let signal: AbortSignal | undefined;
        h = await connectSession(2, {onRequestPermission: (_request, current) => { signal = current; return waiting; }});
        h.emit(turnStarted());
        h.emit(spawn);
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(turnCompleted());
        await flush();
        expect(list()).toEqual([childItem]);
        const approval = h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: worker, turnId: "child-turn", itemId: "approve", command: "echo OK", cwd,
            commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        });
        try {
            await vi.waitFor(() => expect(signal).toBeDefined());
            h.emit(turnStarted("unrelated-turn"));
            await flush();
            await h.cancel();
            await vi.waitFor(() => expect(h.turnInterruptCalls()).toEqual([{threadId: sessionId, turnId: "unrelated-turn"}]));
            await flush();
            expect(signal?.aborted).toBe(false);
            h.emit(turnCompleted("unrelated-turn"));
            await flush();
            await h.request("session/close", {sessionId});
            await vi.waitFor(() => expect(signal?.aborted).toBe(true));
            expect(h.turnInterruptCalls()).toContainEqual({threadId: worker, turnId: "child-turn"});
            await expect(approval).resolves.toEqual({decision: "cancel"});
        } finally { resolve({outcome: {outcome: "cancelled"}}); }
    });

    it("keeps a child foreground when the parent is explicitly waiting on it", async () => {
        h = await connectSession();
        h.emit(turnStarted());
        h.emit(spawn);
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(turnCompleted());
        await flush();
        expect(list()).toEqual([childItem]);

        h.emit(turnStarted("wait-turn"));
        h.emit(itemStarted({
            type: "collabAgentToolCall", id: "join", tool: "wait", status: "inProgress", senderThreadId: sessionId,
            receiverThreadIds: [worker], prompt: null, model: null, reasoningEffort: null, agentsStates: {},
        }, "wait-turn"));
        await flush();
        expect(list()).toEqual([]);
        await h.cancel();
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toContainEqual({threadId: worker, turnId: "child-turn"}));
    });

    it("keeps the session active if close could not stop a detached child", async () => {
        h = await connectSession();
        h.emit(spawn);
        h.emit(onWorker(turnStarted("child-turn")));
        await flush();
        expect(list()).toEqual([childItem]);
        const unsubscribe = vi.fn(async () => ({status: "unsubscribed"}));
        h.setCodexResponse("thread/unsubscribe", unsubscribe);
        h.setCodexResponse("turn/interrupt", async () => { throw new Error("Child interrupt failed"); });
        await expect(h.request("session/close", {sessionId})).rejects.toMatchObject({code: -32603});
        expect(unsubscribe).not.toHaveBeenCalled();
        expect(list()).toEqual([childItem]);
        h.setCodexResponse("turn/interrupt", async () => ({}));
        await expect(h.request("session/close", {sessionId})).resolves.toEqual({});
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("routes child terminal cancel only through the announced ACP child and never its raw Codex ID", async () => {
        h = await connectSession();
        h.setCodexResponse("thread/read", async params => {
            const {threadId} = params as {threadId: string};
            return {thread: {...createThread(), id: threadId, parentThreadId: threadId === worker ? sessionId : null}};
        });
        const terminate = vi.fn(async () => ({terminated: true}));
        h.setCodexResponse("thread/backgroundTerminals/list", async params => ({
            data: (params as {threadId: string}).threadId === worker ? [terminal] : [], nextCursor: null,
        }));
        h.setCodexResponse("thread/backgroundTerminals/terminate", terminate);
        h.emit(spawn);
        startTerminal(event => h.emit(onWorker(event)));
        h.emit(onWorker(turnCompleted()));
        await flush();
        expect(lastState(childId)).toMatchObject({state: "idle", background: [terminalItem]});
        expect(list()).toEqual([childItem]);
        await expect(stop()).rejects.toMatchObject({code: -32602});
        await expect(stop(worker)).rejects.toMatchObject({code: -32002, data: {sessionId: worker}});
        expect(terminate).not.toHaveBeenCalled();
        await expect(stop(childId)).resolves.toEqual({});
        await flush();
        expect(terminate).toHaveBeenCalledExactlyOnceWith({threadId: worker, processId: terminal.processId});
        expect(list(childId)).toEqual([]);
        expect(list()).toEqual([]);
    });
});
