import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ThreadItem} from '../../app-server/v2';
import type {ServerNotification} from '../../app-server';
import {ASYNC_TASK_STOP_METHOD} from '../../async-tasks/AsyncTaskExtension';
import {AIR_ASYNC_TASKS_KEY} from '../../AirExtension';
import {
    sessionId,
    connectSession,
    itemStarted,
    turnStarted,
    turnCompleted,
    createThread,
    createTurn,
    cwd,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

type CommandExecutionItem = Extract<ThreadItem, {type: 'commandExecution'}>;

function commandItem(overrides: Partial<CommandExecutionItem> = {}): CommandExecutionItem {
    return {
        type: "commandExecution",
        id: "command-1",
        pluginId: null,
        scriptPath: null,
        command: "python -m http.server",
        cwd: "/workspace",
        processId: "42",
        source: "unifiedExecStartup",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        ...overrides,
    };
}

const reasoningItem: ThreadItem = {type: "reasoning", id: "reasoning-1", summary: [], content: []};

const asyncTasksClientCapabilities = {
    _meta: {jetbrains: {air: {version: 1, capabilities: [AIR_ASYNC_TASKS_KEY]}}},
};

/** Starts an independent turn after commands detach from the previous turn. */
async function spawnAsyncTask(
    client: {emit: (n: ServerNotification) => void; waitForNotifications: () => Promise<void>},
    commands: CommandExecutionItem[] = [commandItem()],
) {
    client.emit(turnStarted("background-turn"));
    for (const command of commands) client.emit(itemStarted(command, "background-turn"));
    client.emit(turnCompleted("background-turn"));
    await client.waitForNotifications();
    client.emit(turnStarted());
    await client.waitForNotifications();
}

describe('background terminal controls on ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        expectConformingV2SessionUpdates();
    });

    it.each(["missing", "closed"] as const)('reports an unavailable session for terminal Stop (%s)', async state => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        const target = state === "missing" ? "missing-session" : sessionId;
        if (state === "closed") await client.request("session/close", {sessionId});
        await expect(client.request("terminal/cancel", {sessionId: target, terminalId: "command-1"}))
            .rejects.toMatchObject({code: -32002, data: {sessionId: target}});
    });

    it.each(["terminal/cancel", ASYNC_TASK_STOP_METHOD])('stops a declared terminal with %s and preserves foreground work', async method => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/backgroundTerminals/list", async () => ({
            data: [{itemId: "command-1", processId: "42", command: "python -m http.server"}],
            nextCursor: null,
        }));
        client.setCodexResponse("thread/backgroundTerminals/terminate", async () => ({terminated: true}));
        await spawnAsyncTask(client);
        const updates = () => client.scopedUpdates.map(entry => entry.update);
        await vi.waitFor(() => expect(updates()).toContainEqual({sessionUpdate: "state_update", state: "running",
            background: [{type: "terminal", terminalId: "command-1"}]}));
        const declared = updates().findIndex(update => update.sessionUpdate === "terminal_update"
            && update["terminalId"] === "command-1" && update["capabilities"] != null);
        const listed = updates().findIndex(update => update.sessionUpdate === "state_update"
            && JSON.stringify((update["background"] as Array<{terminalId: string}> | undefined)?.map(item => item.terminalId)) === '["command-1"]');
        expect(declared).toBeGreaterThanOrEqual(0);
        expect(listed).toBeGreaterThan(declared);
        const result = await client.request(method, {
            sessionId, ...(method === "terminal/cancel" ? {terminalId: "command-1"} : {asyncTaskId: "command-1"}),
        });
        expect(result).toEqual(method === "terminal/cancel" ? {} : {stopped: true});
        await client.waitForNotifications();
        const exited = updates().findIndex(update => update.sessionUpdate === "terminal_update" && update["exitStatus"] != null);
        const removed = updates().findIndex((update, index) => index > listed && update.sessionUpdate === "state_update"
            && JSON.stringify(update["background"]) === "[]");
        expect(exited).toBeGreaterThan(listed);
        expect(removed).toBeGreaterThan(exited);
        expect(updates().at(removed)).toMatchObject({state: "running"});
        expect(updates().some(update => update.sessionUpdate.startsWith("_async_task"))).toBe(false);
        expect(client.turnInterruptCalls()).toEqual([]);
        await expect(client.request("terminal/cancel", {sessionId, terminalId: "command-1"})).rejects.toMatchObject({code: -32602});
    });

    it.each([undefined, {type: 'start'}])('keeps idle background output after resume with replayFrom %j', async replayFrom => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        let terminals = [
            {itemId: "command-1", processId: "42", command: "python -m http.server"},
            {itemId: "command-2", processId: "43", command: "sleep 60"},
        ];
        client.setCodexResponse("thread/backgroundTerminals/list", async () => ({data: terminals, nextCursor: null}));
        await spawnAsyncTask(client, [commandItem(), commandItem({id: "command-2", processId: "43", command: "sleep 60"})]);
        await client.waitForNotifications();
        const background = terminals.map(terminal => ({type: "terminal", terminalId: terminal.itemId}));
        const states = () => client.scopedUpdates.filter(entry => entry.sessionId === sessionId
            && entry.update.sessionUpdate === "state_update").map(entry => entry.update);
        await vi.waitFor(() => expect(states().at(-1)).toMatchObject({state: "running", background}));
        const before = client.scopedUpdates.length;
        client.emit({method: "item/completed", params: {threadId: sessionId, turnId: "background-turn", completedAtMs: 0,
            item: commandItem({status: "completed", exitCode: 0, aggregatedOutput: "final output"})}});
        await client.waitForNotifications();
        await vi.waitFor(() => expect(states().at(-1)).toMatchObject({state: "running", background: [background[1]]}));
        const completion = client.scopedUpdates.slice(before).map(entry => entry.update);
        const output = completion.findIndex(update => update.sessionUpdate === "terminal_update" && update["output"] != null);
        const removed = completion.findIndex(update => update.sessionUpdate === "state_update"
            && JSON.stringify((update["background"] as Array<{terminalId: string}> | undefined)?.map(item => item.terminalId)) === '["command-2"]');
        expect(output, JSON.stringify(completion, null, 2)).toBeGreaterThanOrEqual(0);
        expect(removed).toBeGreaterThan(output);
        expect(completion[removed]).toMatchObject({state: "running"});
        terminals = terminals.slice(1);
        client.emit(turnCompleted());
        await client.waitForNotifications();
        expect(states().at(-1)).toMatchObject({state: "idle", background: [background[1]]});
        client.setCodexResponse("thread/read", async () => ({thread: {...createThread(), turns: [
            {...createTurn("completed"), itemsView: "full", items: [
                commandItem({status: "completed", exitCode: 0}), commandItem({id: "command-2"}),
            ]},
        ]}}));
        const resumeStart = client.scopedUpdates.length;
        const wireStart = client.wireMessages.length;
        await client.request("session/resume", {sessionId, cwd, ...(replayFrom ? {replayFrom} : {})});
        expect(states().at(-1)).toMatchObject({state: "idle", background: [background[1]]});
        await vi.waitFor(() => expect(client.scopedUpdates.slice(resumeStart)).toContainEqual({sessionId,
            update: {sessionUpdate: "terminal_update", terminalId: "command-2", command: "sleep 60", cwd: "/workspace", capabilities: {cancel: {}}}}));
        await vi.waitFor(() => {
            const frames = client.wireMessages.slice(wireStart);
            const response = frames.findIndex(frame => "result" in frame);
            const control = frames.findIndex((frame, index) => {
                if (!("method" in frame) || frame.method !== "session/update") return false;
                const {update} = frame.params as {update: {sessionUpdate: string; terminalId?: string; capabilities?: {cancel?: unknown}}};
                return update.sessionUpdate === "terminal_update" && update.terminalId === "command-2"
                    && update.capabilities?.cancel != null;
            });
            expect(response).toBeGreaterThanOrEqual(0);
            expect(control).toBeGreaterThanOrEqual(0);
            expect(control).toBeLessThan(response);
        });
        const completionStart = client.scopedUpdates.length;
        client.emit({method: "item/completed", params: {threadId: sessionId, turnId: "background-turn", completedAtMs: 0,
            item: commandItem({id: "command-2", status: "completed", exitCode: 0, aggregatedOutput: "detached output"})}});
        await client.waitForNotifications();
        await vi.waitFor(() => expect(states().at(-1)).toMatchObject({state: "idle", background: []}));
        const detached = client.scopedUpdates.slice(completionStart).map(entry => entry.update);
        const detachedOutput = detached.findIndex(update => update.sessionUpdate === "terminal_update"
            && (update["output"] as {data?: string} | undefined)?.data === Buffer.from("detached output").toString("base64"));
        const detachedRemoval = detached.findIndex(update => update.sessionUpdate === "state_update"
            && JSON.stringify(update["background"]) === "[]");
        expect(detachedOutput, JSON.stringify(detached, null, 2)).toBeGreaterThanOrEqual(0);
        expect(detachedRemoval).toBeGreaterThan(detachedOutput);
        expect(states().at(-1)).toMatchObject({state: "idle", background: []});
    });

    it('discovers detached processes on resume without replay or command history', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/backgroundTerminals/list", async () => ({
            data: [{itemId: "detached", processId: "42", command: "sleep 60"}], nextCursor: null,
        }));
        const start = client.wireMessages.length;
        await client.request("session/resume", {sessionId, cwd});
        const frames = client.wireMessages.slice(start);
        const response = frames.findIndex(frame => "result" in frame);
        const updates = frames.flatMap((frame, index) => "method" in frame && frame.method === "session/update"
            ? [{index, ...(frame.params as {update: {sessionUpdate: string; terminalId?: string; background?: unknown}})}] : []);
        const declaration = updates.find(entry => entry.update.sessionUpdate === "terminal_update"
            && entry.update.terminalId === "detached");
        const snapshot = updates.find(entry => entry.update.sessionUpdate === "state_update"
            && JSON.stringify(entry.update.background) === '[{"type":"terminal","terminalId":"detached"}]');
        expect(declaration).toBeDefined();
        expect(snapshot?.index).toBeGreaterThan(declaration!.index);
        expect(response).toBeGreaterThan(snapshot!.index);
        client.setCodexResponse("thread/backgroundTerminals/terminate", async () => ({terminated: true}));
        await vi.waitFor(async () => expect(await client.request("terminal/cancel", {sessionId, terminalId: "detached"})).toEqual({}));
    });

    it.each(["failed", "interrupted"] as const)('preserves a detached terminal when foreground work is %s', async status => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/backgroundTerminals/list", async () => ({
            data: [{itemId: "command-1", processId: "42", command: "python -m http.server"}], nextCursor: null,
        }));
        await spawnAsyncTask(client);
        await client.waitForNotifications();
        if (status === "interrupted") await client.cancel();
        const start = client.scopedUpdates.length;
        client.emit({method: "turn/completed", params: {threadId: sessionId, turn: {
            ...createTurn(status), ...(status === "failed" ? {error: {
                message: "Foreground failed", codexErrorInfo: null, additionalDetails: null, misalignment: null,
            }} : {}),
        }}});
        await client.waitForNotifications();
        await vi.waitFor(() => expect(client.scopedUpdates.slice(start).map(entry => entry.update)
            .filter(update => update.sessionUpdate === "state_update").at(-1)).toMatchObject({
                state: "idle", background: [{type: "terminal", terminalId: "command-1"}],
            }));
        const updates = client.scopedUpdates.slice(start).map(entry => entry.update);
        expect(updates.some(update => update.sessionUpdate === "terminal_update" && update["exitStatus"] != null)).toBe(false);
        expect(client.turnInterruptCalls()).toEqual(status === "interrupted" ? [{threadId: sessionId, turnId: "turn-1"}] : []);
        client.emit({method: "item/completed", params: {threadId: sessionId, turnId: "background-turn", completedAtMs: 0,
            item: commandItem({status: "completed", exitCode: 0, aggregatedOutput: "late output"})}});
        await client.waitForNotifications();
        await vi.waitFor(() => expect(client.scopedUpdates.map(entry => entry.update)).toContainEqual({
            sessionUpdate: "terminal_update", terminalId: "command-1", capabilities: null,
        }));
        const completed = client.scopedUpdates.map(entry => entry.update);
        expect(completed).toContainEqual(expect.objectContaining({
            sessionUpdate: "terminal_update", terminalId: "command-1", exitStatus: {exitCode: 0, signal: null},
            output: {data: Buffer.from("late output").toString("base64")},
        }));
    });

    it('isolates equal root and child terminal IDs and preserves a refused Stop', async () => {
        const client = await connectSession(2, {clientCapabilities: asyncTasksClientCapabilities});
        closeClient = () => client.connection.close();
        const childThread = "worker";
        const childId = `${sessionId}:subagent:${childThread}`;
        const stopped: unknown[] = [];
        let accepted = false;
        client.setCodexResponse("thread/backgroundTerminals/list", async params => ({
            data: [{itemId: "command-1", processId: (params as {threadId: string}).threadId === sessionId ? "42" : "43",
                command: "python -m http.server"}], nextCursor: null,
        }));
        client.setCodexResponse("thread/backgroundTerminals/terminate", async params => {
            stopped.push(params); return {terminated: accepted};
        });
        await spawnAsyncTask(client);
        client.emit(itemStarted({type: "subAgentActivity", id: "activity", agentThreadId: childThread,
            agentPath: "/root/worker", model: null, reasoningEffort: null, kind: "started"}));
        client.emit({method: "turn/started", params: {threadId: childThread, turn: createTurn("inProgress", "child-turn")}});
        client.emit({method: "item/started", params: {threadId: childThread, turnId: "child-turn", startedAtMs: 0, item: commandItem()}});
        client.emit({method: "turn/completed", params: {threadId: childThread, turn: createTurn("completed", "child-turn")}});
        await client.waitForNotifications();
        client.emit({method: "turn/started", params: {threadId: childThread, turn: createTurn("inProgress", "child-follow-up")}});
        client.emit({method: "item/started", params: {threadId: childThread, turnId: "child-follow-up", startedAtMs: 0, item: reasoningItem}});
        await client.waitForNotifications();
        await vi.waitFor(() => expect(client.scopedUpdates).toContainEqual({sessionId: childId,
            update: {sessionUpdate: "state_update", state: "running", background: [{type: "terminal", terminalId: "command-1"}]}}));
        await expect(client.request("terminal/cancel", {sessionId: childId, terminalId: "command-1"})).rejects.toMatchObject({code: -32602});
        client.emit({method: "turn/completed", params: {threadId: childThread, turn: createTurn("completed", "child-follow-up")}});
        await client.waitForNotifications();
        expect(client.scopedUpdates.filter(entry => entry.sessionId === childId && entry.update.sessionUpdate === "terminal_update")
            .some(entry => (entry.update as {exitStatus?: unknown}).exitStatus != null)).toBe(false);
        accepted = true;
        await client.request("terminal/cancel", {sessionId: childId, terminalId: "command-1"});
        expect(stopped).toEqual([{threadId: childThread, processId: "43"}, {threadId: childThread, processId: "43"}]);
        const states = client.scopedUpdates.filter(entry => entry.update.sessionUpdate === "state_update");
        expect(states.filter(entry => entry.sessionId === sessionId).at(-1)?.update).toMatchObject({
            state: "running", background: [{type: "terminal", terminalId: "command-1"}],
        });
        expect(states.filter(entry => entry.sessionId === childId).at(-1)?.update).toMatchObject({state: "idle", background: []});
        expect(client.turnInterruptCalls()).toEqual([]);
        expect(client.scopedUpdates.some(entry => entry.update.sessionUpdate === "_subagent_update")).toBe(false);
    });

    // The v1 SDK omits private task updates. async-tasks.test.ts checks them through a raw connection.

    it('stopping an unknown task id returns {stopped: false} on both v1 and v2, matching an unknown session', async () => {
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();

            await expect(client.request(ASYNC_TASK_STOP_METHOD, {
                sessionId, asyncTaskId: "no-such-task",
            })).resolves.toEqual({stopped: false});
            await expect(client.request(ASYNC_TASK_STOP_METHOD, {
                sessionId: "no-such-session", asyncTaskId: "no-such-task",
            })).resolves.toEqual({stopped: false});
            client.connection.close();
            closeClient = null;
        }
    });

    it('rejects a blank sessionId with invalid_params on both v1 and v2', async () => {
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();

            await expect(client.request(ASYNC_TASK_STOP_METHOD, {
                sessionId: "   ", asyncTaskId: "command-1",
            })).rejects.toMatchObject({code: -32602});
            client.connection.close();
            closeClient = null;
        }
    });

    it('rejects a blank asyncTaskId with invalid_params on both v1 and v2', async () => {
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();

            await expect(client.request(ASYNC_TASK_STOP_METHOD, {
                sessionId, asyncTaskId: "   ",
            })).rejects.toMatchObject({code: -32602});
            client.connection.close();
            closeClient = null;
        }
    });
});
