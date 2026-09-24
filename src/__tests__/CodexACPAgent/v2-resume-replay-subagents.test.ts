import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY, AIR_ASYNC_TASKS_KEY} from '../../AirExtension';
import type {Thread} from '../../app-server/v2';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

const rootId = "root-1";
const childId = "child-1";
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
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {type: "subAgentActivity", id: "activity-started", kind: "started", agentThreadId: childId, agentPath: `/${rootId}/researcher`},
            {type: "subAgentActivity", id: "activity-completed", kind: "completed", agentThreadId: childId, agentPath: `/${rootId}/researcher`},
        ],
    },
];

/** Child thread history: an agent reply plus a still-running background command. */
const childTurns: Thread["turns"] = [
    {
        id: "child-turn-1",
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
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        ],
    },
];

/** Canned Codex app-server responses for a two-thread (root + subagent) fixture, keyed by method and threadId. */
function codexResponse(method: string, params: unknown): unknown {
    const threadId = (params as {threadId?: string} | undefined)?.threadId;
    switch (method) {
        case "thread/resume":
            return {
                thread: createThread(threadId ?? rootId),
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
                turnsBackwardsCursor: null,
            };
        case "thread/read":
            if (threadId === childId) return {thread: createThread(childId, {turns: childTurns})};
            return {thread: createThread(rootId, {turns: rootTurns})};
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
async function connectV2Client(capabilities: acpV2.ClientCapabilities) {
    const mocks = createMockConnections();
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params: unknown) => (
        codexResponse(method, params)
    ));
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
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
    return {connection, updates};
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

        const subagentUpdates = updates.map(({update}) => update).filter((update) => update.sessionUpdate === "_subagent_update");
        expect(subagentUpdates).toEqual([
            {sessionUpdate: "_subagent_update", subagentSessionId: childId, name: "Researcher", task: "Delegated task for Researcher", capabilities: {}},
            {sessionUpdate: "_subagent_update", subagentSessionId: childId, state: "completed"},
        ]);

        // Async tasks aren't gated on in this capability set, so nothing async-task-shaped renders.
        expect(updates.some(({update}) => update.sessionUpdate.startsWith("_async_task_"))).toBe(false);
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

    it('also emits the child subagent async task when the client also supports asyncTasks (report: not silently lost)', async () => {
        const {connection, updates} = await connectV2Client({
            _meta: {jetbrains: {air: {
                version: 1,
                capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY, AIR_ASYNC_TASKS_KEY],
            }}},
        });
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId: rootId,
            cwd,
            replayFrom: {type: "start"},
        });

        const asyncTaskUpdates = updates.map(({update}) => update).filter((update) => update.sessionUpdate === "_async_task_spawned");
        expect(asyncTaskUpdates).toEqual([
            {
                sessionUpdate: "_async_task_spawned",
                asyncTaskId: "child-1:child-command-1",
                name: "npm test",
                taskType: "shell",
                showInTranscript: false,
                canStop: true,
                toolCallId: "child-command-1",
            },
        ]);
    });
});
