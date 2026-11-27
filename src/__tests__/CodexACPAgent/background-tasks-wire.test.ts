import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import {ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {CodexBackgroundTasks} from '../../async-tasks/CodexBackgroundTasks';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ThreadBackgroundTerminalsListResponse} from '../../async-tasks/BackgroundTerminalApi';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';
import {createTurn} from './v2-prompt-harness';

/** Captures updates through the selected protocol boundary. */
function sessionForVersion(version: 1 | 2, sessionId: string): {session: ACPSessionConnection; updates: unknown[]} {
    const updates: unknown[] = [];
    const connection = {
        notify: vi.fn(async (_method: string, params: unknown) => {
            const update = (params as {update: acpV2.SessionUpdate}).update;
            if (version === 2) checkV2SessionUpdate(update);
            updates.push(update);
        }),
        request: vi.fn(),
    };
    const view = version === 1 ? connection : new AcpV2Connection(connection as any).extensionOnlyV1View();
    return {session: new ACPSessionConnection(view, sessionId), updates};
}

describe.each([1, 2] as const)('Background tasks on ACP v%s', version => {
    afterEach(() => {
        expectConformingV2SessionUpdates();
    });

    function createAsyncTasks() {
        const {session, updates} = sessionForVersion(version, "root");
        const list = vi.fn<() => Promise<ThreadBackgroundTerminalsListResponse>>();
        const appServer = {threadBackgroundTerminalsList: list,
            backgroundTerminalPages: CodexAppServerClient.prototype.backgroundTerminalPages} as unknown as CodexAppServerClient;
        const tasks = new CodexBackgroundTasks(version === 1, "root", appServer, session, version === 2, true);
        return {tasks, list, updates};
    }

    it('discovers a process that outlives its turn without a process ID in the start event', async () => {
        const {tasks, list, updates} = createAsyncTasks();
        list.mockResolvedValue({data: [{itemId: "command-1", processId: "42", command: "python -m http.server", cwd: "/workspace"}], nextCursor: null});

        await tasks.handleNotification({
            method: "item/started",
            params: {
                threadId: "root",
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "commandExecution",
                    id: "command-1",
                    pluginId: null,
                    scriptPath: null,
                    command: "python -m http.server",
                    cwd: "/workspace",
                    processId: null,
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        }, "root");
        await tasks.handleNotification({
            method: "turn/completed", params: {threadId: "root", turn: createTurn("completed")},
        }, "root");
        await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

        expect(updates).toEqual(version === 2 ? [{
            sessionUpdate: "terminal_update", terminalId: "command-1", command: "python -m http.server",
            cwd: "/workspace", capabilities: {cancel: {}},
        }, {sessionUpdate: "state_update", state: "idle", background: [{type: "terminal", terminalId: "command-1"}]}] : [
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "command-1",
                _meta: {jetbrains: {air: {asyncTasks: {backgrounded: true}}}},
            },
            {
                sessionUpdate: "async_task_spawned",
                asyncTaskId: "command-1",
                name: "python -m http.server",
                taskType: "shell",
                showInTranscript: false,
                canStop: true,
                toolCallId: "command-1",
            },
        ]);
        tasks.clear();
    });
});
