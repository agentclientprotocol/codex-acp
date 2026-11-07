import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import {ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {CodexSubagentEventRouter} from '../../subagents/CodexSubagentEventRouter';
import {CodexBackgroundTerminalTasks} from '../../async-tasks/CodexBackgroundTerminalTasks';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ThreadBackgroundTerminalsListResponse} from '../../async-tasks/BackgroundTerminalApi';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

/** Sends the negotiated AIR lifecycle through the selected protocol boundary. */
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

describe.each([1, 2] as const)('AIR subagent and async task updates on ACP v%s', version => {
    afterEach(() => {
        expectConformingV2SessionUpdates();
    });

    it('preserves the AIR spawn and terminal lifecycle when native subagents are enabled', async () => {
        const {session, updates} = sessionForVersion(version, "root");
        const router = new CodexSubagentEventRouter("root", true, session, () => {}, () => ({currentModel: null, availableModels: []}));

        await router.handle({
            method: "item/started",
            params: {
                threadId: "root",
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    model: null,
                    reasoningEffort: null,
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
                    model: null,
                    reasoningEffort: null,
                    id: "activity-interrupted",
                    kind: "interrupted",
                    agentThreadId: "child-1",
                    agentPath: "/root/researcher",
                },
            },
        });

        expect(updates).toEqual([
            {
                sessionUpdate: "subagent_spawned",
                subagentSessionId: "child-1",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {
                sessionUpdate: "subagent_state_update",
                subagentSessionId: "child-1",
                state: "cancelled",
            },
        ]);
    });

    it('announces a new AIR generation for a follow-up turn of a finished subagent', async () => {
        const {session, updates} = sessionForVersion(version, "root");
        const router = new CodexSubagentEventRouter("root", true, session, () => {}, () => ({currentModel: null, availableModels: []}));
        const childTurn = (id: string, status: "completed" | "inProgress") => router.handle({
            method: status === "completed" ? "turn/completed" : "turn/started",
            params: {
                threadId: "child-1",
                turn: {
                    id,
                    items: [],
                    rootTurnId: null,
                    itemsView: "notLoaded",
                    status,
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });

        await router.handle({
            method: "item/started",
            params: {
                threadId: "root",
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    model: null,
                    reasoningEffort: null,
                    id: "activity-started",
                    kind: "started",
                    agentThreadId: "child-1",
                    agentPath: "/root/researcher",
                },
            },
        });
        await childTurn("first-turn", "completed");
        await childTurn("followup-turn", "inProgress");
        await childTurn("followup-turn", "completed");

        expect(updates).toEqual([
            {
                sessionUpdate: "subagent_spawned",
                subagentSessionId: "child-1",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {sessionUpdate: "subagent_state_update", subagentSessionId: "child-1", state: "completed"},
            {
                sessionUpdate: "subagent_spawned",
                subagentSessionId: "child-1:generation:2",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {sessionUpdate: "subagent_state_update", subagentSessionId: "child-1:generation:2", state: "completed"},
        ]);
    });

    it('emits no native lifecycle when native subagents are disabled', async () => {
        const {session, updates} = sessionForVersion(version, "root");
        const router = new CodexSubagentEventRouter("root", false, session, () => {}, () => ({currentModel: null, availableModels: []}));

        const handled = await router.handle({
            method: "item/started",
            params: {
                threadId: "root",
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    model: null,
                    reasoningEffort: null,
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
        const {session, updates} = sessionForVersion(version, "root");
        const list = vi.fn<() => Promise<ThreadBackgroundTerminalsListResponse>>();
        const appServer = {threadBackgroundTerminalsList: list,
            backgroundTerminalPages: CodexAppServerClient.prototype.backgroundTerminalPages} as unknown as CodexAppServerClient;
        const tasks = new CodexBackgroundTerminalTasks(enabled, "root", appServer, session);
        return {tasks, list, updates};
    }

    it('preserves the AIR async task lifecycle when async tasks are enabled', async () => {
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
                sessionUpdate: "async_task_spawned",
                asyncTaskId: "command-1",
                name: "python -m http.server",
                taskType: "shell",
                showInTranscript: false,
                canStop: true,
                toolCallId: "command-1",
            },
        ]);
    });

    it('emits no async task lifecycle when async tasks are disabled', async () => {
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
