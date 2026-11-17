import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import {ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {CodexSubagentEventRouter} from '../../subagents/CodexSubagentEventRouter';
import {CodexBackgroundTasks} from '../../async-tasks/CodexBackgroundTasks';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ThreadBackgroundTerminalsListResponse} from '../../async-tasks/BackgroundTerminalApi';
import type {ResponseItem} from "../../app-server/ResponseItem";
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
                sessionUpdate: version === 1 ? "subagent_spawned" : "_subagent_update",
                subagentSessionId: "child-1",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {
                sessionUpdate: version === 1 ? "subagent_state_update" : "_subagent_update",
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
                sessionUpdate: version === 1 ? "subagent_spawned" : "_subagent_update",
                subagentSessionId: "child-1",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {sessionUpdate: version === 1 ? "subagent_state_update" : "_subagent_update", subagentSessionId: "child-1", state: "completed"},
            {
                sessionUpdate: version === 1 ? "subagent_spawned" : "_subagent_update",
                subagentSessionId: "child-1:generation:2",
                name: "Researcher",
                task: "Delegated task for Researcher",
                capabilities: {},
            },
            {sessionUpdate: version === 1 ? "subagent_state_update" : "_subagent_update", subagentSessionId: "child-1:generation:2", state: "completed"},
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
        const backgrounds: acpV2.BackgroundWork[][] = [];
        const tasks = new CodexBackgroundTasks(enabled, "root", appServer, session, {
            changed: async sessionId => { backgrounds.push(tasks.snapshot(sessionId)); },
        });
        const raw = (item: ResponseItem, threadId = "root") => tasks.handleNotification({
            method: "rawResponseItem/completed", params: {threadId, turnId: "turn-1", item},
        }, threadId);
        return {tasks, list, updates, backgrounds, raw};
    }

    it('publishes the enabled tracker through the selected protocol', async () => {
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

        expect(updates).toEqual(version === 2 ? [{
            sessionUpdate: "terminal_update", terminalId: "command-1", command: "python -m http.server",
            capabilities: {cancel: {}},
        }] : [
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "command-1",
                _meta: {jetbrains: {air: {asyncTasks: {backgrounded: true}}}},
            },
            {
                sessionUpdate: version === 1 ? "async_task_spawned" : "_async_task_spawned",
                asyncTaskId: "command-1",
                name: "python -m http.server",
                taskType: "shell",
                showInTranscript: false,
                canStop: true,
                toolCallId: "command-1",
            },
        ]);
    });

    it.each(["custom_tool_call_output", "function_call_output"] as const)(
        'discovers a background command after %s while the foreground turn continues', async type => {
            const {tasks, list, updates, raw} = createAsyncTasks(true);
            list.mockResolvedValue({data: [{itemId: "command-1", processId: "42", command: "sleep 15"}], nextCursor: null});

            await raw({type, call_id: "counter", output: JSON.stringify({session_id: 42, output: "1"})});

            await vi.waitFor(() => expect(updates).toContainEqual(expect.objectContaining(version === 2 ? {
                sessionUpdate: "terminal_update", terminalId: "command-1", command: "sleep 15",
            } : {
                sessionUpdate: "async_task_spawned", asyncTaskId: "command-1", toolCallId: "command-1",
            })));
            expect(tasks.snapshot("root")).toEqual([{type: "terminal", terminalId: "command-1"}]);
        },
    );

    it('reports yielded code through tool calls and standard background references', async () => {
        const {tasks, updates, backgrounds, raw} = createAsyncTasks(false);
        await raw({type: "custom_tool_call", call_id: "counter", name: "exec", input: "notify(1)"});
        await raw({type: "custom_tool_call_output", call_id: "counter", id: "yield",
            output: "Script running with cell ID 4\nWall time 0.1 seconds\nOutput:\n"});
        expect(tasks.snapshot("root")).toEqual(version === 2 ? [{type: "tool_call", toolCallId: "counter"}] : []);
        await raw({type: "function_call", call_id: "wait-1", name: "wait", arguments: '{"cell_id":"4"}'});
        await raw({type: "function_call_output", call_id: "wait-1", output: "Script running with cell ID 4\nOutput:\n1"});
        expect(tasks.snapshot("root")).toEqual(version === 2 ? [{type: "tool_call", toolCallId: "counter"}] : []);
        await raw({type: "function_call", call_id: "wait-2", name: "wait", arguments: '{"cell_id":"4"}'});
        await raw({type: "function_call_output", call_id: "wait-2", output: [
            {type: "input_text", text: "Script completed\nOutput:\n"}, {type: "input_text", text: "Counted"},
        ]});
        expect(tasks.snapshot("root")).toEqual([]);
        const lateOutput: ResponseItem = {type: "custom_tool_call_output", call_id: "counter", id: "late-1", output: "2"};
        await raw(lateOutput);
        const afterLate = updates.length;
        await raw(lateOutput);
        expect(updates).toHaveLength(afterLate);
        expect(updates.at(-1)).toMatchObject({sessionUpdate: "tool_call_update", toolCallId: "counter", status: "completed",
            rawOutput: {outputs: [expect.stringContaining("Script running"), expect.any(Array), "2"]}});
        expect(backgrounds.at(-1)).toEqual([]);
        expect(updates.filter((update: any) => (version === 1 ? update.sessionUpdate === "tool_call" : update.title !== undefined))).toMatchObject([
            {toolCallId: "counter", title: "Run code", rawInput: {code: "notify(1)"}},
            {toolCallId: "wait-1", title: "Wait for code", rawInput: {cell_id: "4"}},
            {toolCallId: "wait-2", title: "Wait for code", rawInput: {cell_id: "4"}},
        ]);
        expect(updates.every((update: any) => update._meta === undefined)).toBe(true);
    });

    it('matches a reused native cell ID to the active call', async () => {
        const {tasks, updates, raw} = createAsyncTasks(false);
        for (const id of ["first", "second"]) {
            await raw({type: "custom_tool_call", call_id: id, name: "exec", input: "text(1)"});
            await raw({type: "custom_tool_call_output", call_id: id, output: "Script running with cell ID 4"});
            await raw({type: "function_call", call_id: `wait-${id}`, name: "wait", arguments: '{"cell_id":"4"}'});
            await raw({type: "function_call_output", call_id: `wait-${id}`, output: "Script completed"});
            expect(updates.at(-1)).toMatchObject({toolCallId: id, status: "completed"});
            expect(tasks.snapshot("root")).toEqual([]);
        }
    });

    it.each([
        ["Script completed\nOutput:\nDone", "completed"],
        ["Script failed\nError: test", "failed"],
        ["SyntaxError: test", "completed"],
    ])('ends synchronous code for the native result %s', async (output, status) => {
        const {tasks, updates, raw} = createAsyncTasks(false);
        await raw({type: "custom_tool_call", call_id: "code", name: "exec", input: "text(1)"});
        await raw({type: "custom_tool_call_output", call_id: "code", output});
        expect(updates.at(-1)).toMatchObject({sessionUpdate: "tool_call_update", toolCallId: "code", status});
        expect(tasks.snapshot("root")).toEqual([]);
        await tasks.finishAll("failed");
        expect(updates).toHaveLength(2);
    });

    it('isolates code results by thread and releases active cells when the native process changes', async () => {
        const {tasks, updates, raw} = createAsyncTasks(false);
        await raw({type: "custom_tool_call", call_id: "code", name: "exec", input: "text(1)"});
        await raw({type: "custom_tool_call_output", call_id: "code", output: "Script completed"}, "another-thread");
        expect(updates).toHaveLength(1);
        await raw({type: "custom_tool_call_output", call_id: "code", output: "Script running with cell ID 4"});
        await tasks.prepareForAppServerReplacement();
        expect(updates.at(-1)).toMatchObject({toolCallId: "code", status: "failed"});
        expect(tasks.snapshot("root")).toEqual([]);
        tasks.clear();
        const count = updates.length;
        await raw({type: "custom_tool_call", call_id: "ignored", name: "exec", input: "text(1)"});
        expect(updates).toHaveLength(count);
    });

    it('keeps malformed wait input visible and ignores unrelated raw items', async () => {
        const {updates, raw} = createAsyncTasks(false);
        await raw({type: "function_call", call_id: "other", name: "exec_command", arguments: "{}"});
        await raw({type: "custom_tool_call", call_id: "mcp", namespace: "mcp", name: "exec", input: "text(1)"});
        await raw({type: "custom_tool_call_output", call_id: "missing", output: "Script completed"});
        expect(updates).toEqual([]);
        await raw({type: "function_call", call_id: "broken", name: "wait", arguments: "{"});
        await raw({type: "function_call_output", call_id: "broken", output: "Invalid arguments"});
        expect(updates).toMatchObject([
            {sessionUpdate: version === 1 ? "tool_call" : "tool_call_update", toolCallId: "broken", rawInput: {arguments: "{"}},
            {sessionUpdate: "tool_call_update", toolCallId: "broken", status: "completed"},
        ]);
    });

    it('emits no async task lifecycle when async tasks are disabled' , async () => {
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
