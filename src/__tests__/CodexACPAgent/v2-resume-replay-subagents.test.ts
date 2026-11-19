import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk/unstable';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY, AIR_ASYNC_TASKS_KEY} from '../../AirExtension';
import type {Thread} from '../../app-server/v2';
import type {ServerNotification} from '../../app-server';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

const rootId = "root-1";
const childId = "child-1";
const childSessionId = `${rootId}:subagent:${childId}`;
const cwd = "/workspace";

function createThread(id: string, overrides?: Partial<Thread>): Thread {
    return {
        id,
        sessionId: id,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "Earlier session",
        ephemeral: false,
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 100,
        updatedAt: 200,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd,
        cliVersion: "0.0.0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        ...overrides,
    };
}

/**
 * Root thread with a completed subagent delegation: a `subAgentActivity` "started" followed by
 * "completed" for `childId`, so `streamNativeThreadHistory` announces the child, replays its
 * history, then marks it terminal -- exactly the shape that used to throw -32603 through the
 * fail-loud v2 renderer.
 */
const rootTurns: Thread["turns"] = [
    {
        id: "root-turn-1",
        rootTurnId: null,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {type: "subAgentActivity", model: null, reasoningEffort: null, id: "activity-started", kind: "started", agentThreadId: childId, agentPath: `/${rootId}/researcher`},
            {type: "subAgentActivity", model: null, reasoningEffort: null, id: "activity-completed", kind: "completed", agentThreadId: childId, agentPath: `/${rootId}/researcher`},
        ],
    },
];

/** Child thread history: an agent reply plus a still-running background command. */
const childTurns: Thread["turns"] = [
    {
        id: "child-turn-1",
        rootTurnId: null,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {
                type: "commandExecution",
                id: "child-command-1",
                pluginId: null,
                scriptPath: null,
                command: "npm test",
                cwd,
                processId: "42",
                source: "unifiedExecStartup",
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
            },
            {
                type: "agentMessage",
                id: "child-reply",
                text: "Investigating the flaky test.",
                phase: null,
                moderation: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        ],
    },
];

type HistoryTurns = {root: Thread["turns"]; child: Thread["turns"]};

/** Canned Codex app-server responses for a two-thread (root + subagent) fixture, keyed by method and threadId. */
function codexResponse(method: string, params: unknown, turns: HistoryTurns, liveChild: boolean): unknown {
    const threadId = (params as {threadId?: string} | undefined)?.threadId;
    switch (method) {
        case "thread/resume":
            return {
                thread: createThread(threadId ?? rootId, {parentThreadId: liveChild && threadId === childId ? rootId : null}),
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
                turnsBackwardsCursor: null,
            };
        case "thread/read":
            if (threadId === childId) return {thread: createThread(childId, {turns: turns.child, parentThreadId: liveChild ? rootId : null})};
            return {thread: createThread(rootId, {turns: turns.root})};
        case "thread/backgroundTerminals/list":
            if (threadId === childId) {
                return {data: [{itemId: "child-command-1", processId: "42", command: "npm test"}], nextCursor: null};
            }
            return {data: [], nextCursor: null};
        case "model/list":
            return {data: [createTestModel({id: "gpt-5"})], nextCursor: null};
        case "skills/list":
            return {data: []};
        case "config/read":
            return {config: {}, origins: {}, layers: []};
        case "thread/list":
            return {data: [createThread(rootId)], nextCursor: null};
        case "thread/goal/get":
            return {goal: null};
        default:
            return {};
    }
}

/** Connects a v2 client to the agent through the router, over a mocked (threadId-aware) Codex app-server. */
async function connectV2Client(
    capabilities: acpV2.ClientCapabilities,
    turns: HistoryTurns = {root: rootTurns, child: childTurns},
    liveChild = false,
) {
    const mocks = createMockConnections();
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params: unknown) => (
        codexResponse(method, params, turns, liveChild)
    ));
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, userId: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue({ready: [], failed: [], cancelled: []});
    const router = createAcpAgentRouter((connection) => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const updates: acpV2.UpdateSessionNotification[] = [];
    const connection = acpV2.client({name: "test-client"})
        .onNotification(acpV2.methods.client.session.update, (ctx) => {
            checkV2SessionUpdate(ctx.params.update);
            updates.push(ctx.params);
        })
        .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: {name: "test-client", version: "1.0.0"},
        capabilities,
    });
    return {connection, updates, emit(notification: ServerNotification) {
        const handler = mocks.notificationHandlers.get(notification.method);
        if (handler) handler(notification.params);
        else mocks.getUnhandledNotificationHandler()!(notification);
    }};
}

describe('ACP v2 resume replay: native subagent history (nativeSubagentSessions client)', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('replays a thread with subAgentActivity to completion instead of failing with -32603', async () => {
        const {connection, updates} = await connectV2Client({
            _meta: {jetbrains: {air: {version: 1, capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY]}}},
        });
        closeClient = () => connection.close();

        // Before this slice, the child's `subagent_spawned`/`subagent_state_update` updates hit
        // the fail-loud renderer and this request rejected with -32603 partway through replay.
        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId: rootId,
            cwd,
            replayFrom: {type: "start"},
        });

        const declaration = updates.find(({update}) => update.sessionUpdate === "subagent_update"
            && update.sessionId === childSessionId);
        expect(declaration).toMatchObject({sessionId: rootId, update: {
            sessionUpdate: "subagent_update", sessionId: childSessionId, title: "Researcher", capabilities: {},
        }});
        expect(updates).toContainEqual({sessionId: rootId,
            update: {sessionUpdate: "subagent_update", sessionId: childSessionId, state: {state: "idle", stopReason: "end_turn"}}});
        expect(updates.some(({update}) => update.sessionUpdate.startsWith("_subagent")
            || update.sessionUpdate.startsWith("_async_task"))).toBe(false);
    });

    it('also emits the child subagent history (agent reply) alongside the lifecycle updates', async () => {
        const {connection, updates} = await connectV2Client({
            _meta: {jetbrains: {air: {version: 1, capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY]}}},
        });
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId: rootId,
            cwd,
            replayFrom: {type: "start"},
        });

        const agentMessages = updates
            .map(({update}) => update)
            .filter((update) => update.sessionUpdate === "agent_message_chunk")
            .map((update) => (update as {content: {type: string; text?: string}}).content)
            .map((content) => (content.type === "text" ? content.text : null));
        expect(agentMessages).toContain("Investigating the flaky test.");
    });

    it('does not replay historical child configuration on the AIR contract either', async () => {
        const root: Thread["turns"] = [{
            ...rootTurns[0]!,
            items: [
                {
                    type: "collabAgentToolCall",
                    id: "spawn-1",
                    tool: "spawnAgent",
                    status: "completed",
                    senderThreadId: rootId,
                    receiverThreadIds: [childId],
                    prompt: "Research",
                    model: "gpt-5",
                    reasoningEffort: null,
                    agentsStates: {},
                },
                {...rootTurns[0]!.items[0]!, model: "gpt-5"} as Thread["turns"][number]["items"][number],
                ...rootTurns[0]!.items.slice(1),
            ],
        }];
        const {connection, updates} = await connectV2Client({
            _meta: {jetbrains: {air: {version: 1, capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY]}}},
        }, {root, child: childTurns});
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId: rootId,
            cwd,
            replayFrom: {type: "start"},
        });

        expect(updates.some(({sessionId, update}) => sessionId === childId && update.sessionUpdate === "config_option_update")).toBe(false);
    });

    it('preserves one child identity across replayed follow-up turns', async () => {
        const turn = (id: string, items: Thread["turns"][number]["items"]): Thread["turns"][number] => ({
            id,
            rootTurnId: null,
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            items,
        });
        const activity = (id: string, kind: "started" | "interacted" | "completed") => ({
            type: "subAgentActivity" as const,
            model: null,
            reasoningEffort: null,
            id,
            kind,
            agentThreadId: childId,
            agentPath: `/${rootId}/researcher`,
        });
        const reply = (id: string, text: string) => ({
            type: "agentMessage" as const,
            id,
            text,
            phase: null,
            moderation: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
        });
        const {connection, updates} = await connectV2Client({
            _meta: {jetbrains: {air: {version: 1, capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY]}}},
        }, {
            // Codex records a follow-up to a finished child as an `interacted` activity of the parent.
            root: [
                turn("root-turn-1", [activity("spawn", "started"), activity("first-done", "completed")]),
                turn("root-turn-2", [activity("followup", "interacted"), activity("followup-done", "completed")]),
            ],
            child: [
                turn("child-turn-1", [reply("first-reply", "First answer.")]),
                turn("child-turn-2", [reply("followup-reply", "Follow-up answer.")]),
            ],
        });
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId: rootId,
            cwd,
            replayFrom: {type: "start"},
        });

        const declarations = updates.filter(({update}) => update.sessionUpdate === "subagent_update"
            && update.capabilities != null && Object.keys(update.capabilities).length === 0);
        expect(declarations).toHaveLength(1);
        expect(declarations[0]).toMatchObject({sessionId: rootId, update: {sessionId: childSessionId}});
        const replies = updates
            .filter(({sessionId, update}) => sessionId === childSessionId && update.sessionUpdate === "agent_message_chunk")
            .map(({update}) => (update as {content: {text: string}}).content.text);
        expect(replies).toEqual(["First answer.", "Follow-up answer."]);
    });

    it('publishes the child background terminal and late output through the standard route for an Air client', async () => {
        const {connection, updates, emit} = await connectV2Client({
            _meta: {jetbrains: {air: {
                version: 1,
                capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY, AIR_ASYNC_TASKS_KEY],
            }}},
        }, {root: rootTurns, child: childTurns}, true);
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId: rootId,
            cwd,
            replayFrom: {type: "start"},
        });

        const declaration = updates.findIndex(({sessionId, update}) => sessionId === childSessionId
            && update.sessionUpdate === "terminal_update" && update.terminalId === "child-command-1"
            && (update as acpV2.TerminalUpdate).capabilities?.cancel != null);
        const listed = updates.findIndex(({sessionId, update}) => sessionId === childSessionId
            && update.sessionUpdate === "state_update" && JSON.stringify((update["background"] as Array<{terminalId: string}> | undefined)?.map(item => item.terminalId))
                === '["child-command-1"]');
        expect(declaration).toBeGreaterThanOrEqual(0);
        expect(listed).toBeGreaterThan(declaration);
        expect(updates.some(({update}) => update.sessionUpdate.startsWith("_async_task"))).toBe(false);
        const start = updates.length;
        emit({method: "item/completed", params: {threadId: childId, turnId: "child-turn-1", completedAtMs: 1,
            item: {...childTurns[0]!.items[0]!, type: "commandExecution", status: "completed", exitCode: 0,
                aggregatedOutput: "Child detached output"} as Extract<Thread["turns"][number]["items"][number], {type: "commandExecution"}>,
        }});
        await vi.waitFor(() => {
            const completion = updates.slice(start).filter(entry => entry.sessionId === childSessionId);
            const output = completion.findIndex(({update}) => {
                if (update.sessionUpdate !== "terminal_update") return false;
                const terminal = update as acpV2.TerminalUpdate;
                return terminal.output?.data === Buffer.from("Child detached output").toString("base64") && terminal.exitStatus?.exitCode === 0;
            });
            const removed = completion.findIndex(({update}) => update.sessionUpdate === "state_update"
                && JSON.stringify(update.background) === "[]");
            expect(output).toBeGreaterThanOrEqual(0);
            expect(removed).toBeGreaterThan(output);
        });
    });
});
