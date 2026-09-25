import {afterEach, describe, expect, it} from 'vitest';
import type {ThreadItem} from '../../app-server/v2';
import type {ServerNotification} from '../../app-server';
import {ASYNC_TASK_STOP_METHOD} from '../../async-tasks/AsyncTaskExtension';
import {AIR_ASYNC_TASKS_KEY} from '../../AirExtension';
import {
    sessionId,
    connectSession,
    itemStarted,
    turnStarted,
    settle,
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

/** Emits the notifications that make `CodexBackgroundTerminalTasks` announce and sync a spawned task. */
async function spawnAsyncTask(client: {emit: (n: ServerNotification) => void}) {
    client.emit(turnStarted());
    await settle();
    client.emit(itemStarted(commandItem()));
    await settle();
    // A second `item/started` triggers the terminal-list sync that publishes the spawn.
    client.emit(itemStarted(reasoningItem));
    await settle();
}

describe('_session/async_task/stop on ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        expectConformingV2SessionUpdates();
    });

    it('stops a spawned async task on v2, returning {stopped: true} and rendering _async_task_state_update', async () => {
        const client = await connectSession(2, {clientCapabilities: asyncTasksClientCapabilities});
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/backgroundTerminals/list", async () => ({
            data: [{itemId: "command-1", processId: "42", command: "python -m http.server"}],
            nextCursor: null,
        }));
        client.setCodexResponse("thread/backgroundTerminals/terminate", async () => ({terminated: true}));

        await spawnAsyncTask(client);

        const spawned = client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
            .filter(update => update.sessionUpdate === "_async_task_spawned");
        expect(spawned).toEqual([expect.objectContaining({asyncTaskId: "command-1"})]);

        const stopRequest = client.request(ASYNC_TASK_STOP_METHOD, {sessionId, asyncTaskId: "command-1"});
        await expect(stopRequest).resolves.toEqual({stopped: true});
        await settle();

        const stateUpdates = client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
            .filter(update => update.sessionUpdate === "_async_task_state_update");
        expect(stateUpdates).toEqual([{sessionUpdate: "_async_task_state_update", asyncTaskId: "command-1", state: "stopped", toolCallId: "command-1"}]);
    });

    // v1 renders the same lifecycle as bare `async_task_spawned`/`async_task_state_update` tags
    // (pre-`_`-prefix convention), which the real v1 SDK client schema does not model -- see
    // `async-tasks.test.ts` for the v1 rendering pin, using a raw mock connection instead of the
    // real wire-validating client. This file's v1 iterations below pin the *router-level*
    // extension-method behavior (params, unknown-session/task handling, errors), which is
    // unaffected by that.

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
