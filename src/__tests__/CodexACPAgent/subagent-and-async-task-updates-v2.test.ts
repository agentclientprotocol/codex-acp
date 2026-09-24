import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {CodexSubagentEventRouter} from '../../subagents/CodexSubagentEventRouter';
import {CodexBackgroundTerminalTasks} from '../../async-tasks/CodexBackgroundTerminalTasks';
import type {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ThreadBackgroundTerminalsListResponse} from '../../async-tasks/BackgroundTerminalApi';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

/** A v2-wrapped `ACPSessionConnection`, so `session.update()` renders through `toV2SessionUpdate`. */
function v2Session(sessionId: string): {session: ACPSessionConnection; updates: acpV2.SessionUpdate[]} {
    const updates: acpV2.SessionUpdate[] = [];
    const v2Client = {
        notify: vi.fn(async (_method: string, params: unknown) => {
            const update = (params as {update: acpV2.SessionUpdate}).update;
            checkV2SessionUpdate(update);
            updates.push(update);
        }),
        request: vi.fn(),
    };
    const view = new AcpV2Connection(v2Client as any).extensionOnlyV1View();
    return {session: new ACPSessionConnection(view, sessionId), updates};
}

describe('subagent and async task updates on ACP v2', () => {
    afterEach(() => {
        expectConformingV2SessionUpdates();
    });

    it('renders the subagent lifecycle as `_subagent_update` when native subagents are enabled', async () => {
        const {session, updates} = v2Session("root");
        const router = new CodexSubagentEventRouter("root", true, session);

        await router.handle({
            method: "item/started",
            params: {
                threadId: "root",
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "activity-started",
                    kind: "started",
                    agentThreadId: "child-1",
                    agentPath: "/root/researcher",
                },
            },
        });
        await router.handle({
            method: "item/completed",
            params: {
                threadId: "root",
                turnId: "turn-1",
                completedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "activity-interrupted",
                    kind: "interrupted",
                    agentThreadId: "child-1",
                    agentPath: "/root/researcher",
                },
            },
        });

        expect(updates).toEqual([
            {
                sessionUpdate: "_subagent_update",
                subagentSessionId: "child-1",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {
                sessionUpdate: "_subagent_update",
                subagentSessionId: "child-1",
                state: "cancelled",
            },
        ]);
    });

    it('never emits `_subagent_update` (or `subagent_spawned`) when native subagents are disabled', async () => {
        const {session, updates} = v2Session("root");
        const router = new CodexSubagentEventRouter("root", false, session);

        const handled = await router.handle({
            method: "item/started",
            params: {
                threadId: "root",
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "activity-started",
                    kind: "started",
                    agentThreadId: "child-1",
                    agentPath: "/root/researcher",
                },
            },
        });

        // Same as v1: an unsupported client gets no native representation at all -- the ordinary
        // event mapper renders the activity as a ordinary tool call instead (untouched by this router).
        expect(handled).toBe(false);
        expect(updates).toEqual([]);
    });

    function createAsyncTasks(enabled: boolean) {
        const {session, updates} = v2Session("root");
        const list = vi.fn<() => Promise<ThreadBackgroundTerminalsListResponse>>();
        const appServer = {threadBackgroundTerminalsList: list} as unknown as CodexAppServerClient;
        const tasks = new CodexBackgroundTerminalTasks(enabled, "root", appServer, session);
        return {tasks, list, updates};
    }

    it('renders async task updates as `_async_task_*` when async tasks are enabled', async () => {
        const {tasks, list, updates} = createAsyncTasks(true);
        list.mockResolvedValue({data: [{itemId: "command-1", processId: "42", command: "python -m http.server"}], nextCursor: null});

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
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        }, "root");
        await tasks.sync("root", "root");

        expect(updates).toEqual([
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "command-1",
                _meta: {jetbrains: {air: {asyncTasks: {backgrounded: true}}}},
            },
            {
                sessionUpdate: "_async_task_spawned",
                asyncTaskId: "command-1",
                name: "python -m http.server",
                taskType: "shell",
                showInTranscript: false,
                canStop: true,
                toolCallId: "command-1",
            },
        ]);
    });

    it('never emits `_async_task_*` (or `async_task_*`) when async tasks are disabled', async () => {
        const {tasks, list, updates} = createAsyncTasks(false);
        list.mockResolvedValue({data: [], nextCursor: null});

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
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                },
            },
        }, "root");
        await tasks.sync("root", "root");

        expect(updates).toEqual([]);
        expect(list).not.toHaveBeenCalled();
    });
});
