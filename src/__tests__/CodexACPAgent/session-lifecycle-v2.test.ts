import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {Thread} from '../../app-server/v2';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

const sessionId = "thread-1";
const cwd = "/workspace";

function createThread(overrides?: Partial<Thread>): Thread {
    return {
        id: sessionId,
        sessionId,
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

/** Canned Codex app-server responses, keyed by method. */
function codexResponse(method: string, replayTurns: Thread["turns"] = []): unknown {
    switch (method) {
        case "thread/start":
        case "thread/resume":
            return {
                thread: createThread(),
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
                turnsBackwardsCursor: null,
            };
        case "thread/read":
            // `threadReadWithHistory` reads twice for a "legacy" history-mode thread (once to
            // learn the history mode, once with `includeTurns: true`); returning the full
            // history from both is harmless since only the second response is used.
            return {thread: createThread({turns: replayTurns})};
        case "model/list":
            return {data: [createTestModel({id: "gpt-5"})], nextCursor: null};
        case "skills/list":
            return {data: []};
        case "config/read":
            return {config: {}, origins: {}, layers: []};
        case "thread/list":
            return {data: [createThread()], nextCursor: null};
        case "thread/goal/get":
            return {goal: null};
        default:
            return {};
    }
}

/** Methods whose requests the snapshots record; the rest is session-setup noise. */
const recordedCodexMethods = new Set([
    "thread/start",
    "thread/resume",
    "thread/list",
    "thread/unsubscribe",
    "thread/archive",
]);

/** Connects a v2 client to the agent through the router, over a mocked Codex app-server. */
async function connectV2Client(options?: {replayTurns?: Thread["turns"]}) {
    const mocks = createMockConnections();
    const codexRequests: Array<{method: string, params: unknown}> = [];
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
        if (recordedCodexMethods.has(method)) {
            codexRequests.push({method, params});
        }
        return codexResponse(method, options?.replayTurns);
    });
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue({ready: [], failed: [], cancelled: []});
    let agent: CodexAcpServer | null = null;
    const router = createAcpAgentRouter((connection) => {
        agent = new CodexAcpServer(connection, codexAcpClient);
        return agent;
    });
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
    });
    return {connection, agent: () => agent!, codexRequests, updates};
}

/**
 * Waits for the updates a session publishes on its own after `session/new` or `session/resume`,
 * and returns them in a stable order (they are published concurrently).
 */
async function waitForSessionUpdates(
    updates: acpV2.UpdateSessionNotification[],
    expected: Array<acpV2.SessionUpdate["sessionUpdate"]>,
) {
    await vi.waitFor(() => expect(updates.map(({update}) => update.sessionUpdate).sort()).toEqual(expected));
    return [...updates].sort((a, b) => a.update.sessionUpdate.localeCompare(b.update.sessionUpdate));
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

describe('Session lifecycle over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('creates a session without mcpServers and answers with sessionId and configOptions only', async () => {
        const {connection, codexRequests, updates} = await connectV2Client();
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.new, {cwd});
        const sessionUpdates = await waitForSessionUpdates(updates, ["available_commands_update"]);

        await expect(dump({response, codexRequests, updates: sessionUpdates}))
            .toMatchFileSnapshot('data/session-lifecycle-v2-new.json');
    });

    it('creates a session with v2 mcpServers', async () => {
        const {connection, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.new, {
            cwd,
            mcpServers: [
                {type: "stdio", name: "files", command: "/usr/local/bin/mcp-fs", args: ["--root", cwd]},
                {type: "http", name: "remote", url: "https://example.com/mcp"},
            ],
        });

        expect(response.sessionId).toBe(sessionId);
        await expect(dump(codexRequests)).toMatchFileSnapshot('data/session-lifecycle-v2-new-mcp-servers.json');
    });

    it('lists sessions', async () => {
        const {connection, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.list, {cwd});

        await expect(dump({response, codexRequests})).toMatchFileSnapshot('data/session-lifecycle-v2-list.json');
    });

    it('closes a session', async () => {
        const {connection, agent, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();
        await connection.agent.request(acpV2.methods.agent.session.new, {cwd});
        codexRequests.splice(0);

        const response = await connection.agent.request(acpV2.methods.agent.session.close, {sessionId});

        expect(() => agent().getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
        await expect(dump({response, codexRequests})).toMatchFileSnapshot('data/session-lifecycle-v2-close.json');
    });

    it('deletes a session', async () => {
        const {connection, agent, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();
        await connection.agent.request(acpV2.methods.agent.session.new, {cwd});
        codexRequests.splice(0);

        const response = await connection.agent.request(acpV2.methods.agent.session.delete, {sessionId});

        expect(() => agent().getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
        await expect(dump({response, codexRequests})).toMatchFileSnapshot('data/session-lifecycle-v2-delete.json');
    });

    it('resumes a session without replayFrom and answers with configOptions only', async () => {
        const {connection, codexRequests, updates} = await connectV2Client();
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd});
        // Only the command list and the current goal; no history is replayed.
        const sessionUpdates = await waitForSessionUpdates(
            updates,
            ["available_commands_update", "session_info_update"],
        );

        await expect(dump({response, codexRequests, updates: sessionUpdates}))
            .toMatchFileSnapshot('data/session-lifecycle-v2-resume.json');
    });

    it('resumes a session with a null replayFrom the same way', async () => {
        const {connection, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: null,
        });

        await expect(dump({response, codexRequests}))
            .toMatchFileSnapshot('data/session-lifecycle-v2-resume-null-replay.json');
    });

    it('rejects resume with an unknown replayFrom type', async () => {
        const {connection, agent, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();

        const error = await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "_checkpoint", checkpointId: "c-1"},
        }).then(() => null, (err) => ({code: err.code, message: err.message, data: err.data}));

        expect(codexRequests).toEqual([]);
        expect(() => agent().getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
        await expect(dump(error)).toMatchFileSnapshot('data/session-lifecycle-v2-resume-unknown-replay.json');
    });

    /** A turn with a prompt-inserted user message, a legacy one, an agent message and a tool call. */
    const replayTurns: Thread["turns"] = [{
        id: "turn-1",
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {
                type: "userMessage",
                id: "item-user-1",
                clientId: "client-user-1",
                content: [{type: "text", text: "Inserted via session/prompt", text_elements: []}],
            },
            {
                type: "userMessage",
                id: "item-user-2",
                clientId: null,
                content: [{type: "text", text: "A legacy message with no clientId", text_elements: []}],
            },
            {
                type: "agentMessage",
                id: "item-agent-1",
                text: "Hello!",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
            {
                type: "commandExecution",
                id: "item-cmd-1",
                pluginId: null,
                scriptPath: null,
                command: "ls",
                cwd,
                processId: null,
                source: "agent",
                status: "completed",
                commandActions: [],
                aggregatedOutput: "README.md\n",
                exitCode: 0,
                durationMs: 5,
            },
        ],
    }];

    it('replays history before answering resume with replayFrom start', async () => {
        const {connection, agent, codexRequests, updates} = await connectV2Client({replayTurns});
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });

        // RESUME-202: every replayed update must have already arrived by the time the response
        // resolves; nothing should still be pending afterwards.
        const replayedUpdates = [...updates];
        expect(agent().getSessionState(sessionId)).toBeTruthy();

        await expect(dump({response, codexRequests, updates: replayedUpdates}))
            .toMatchFileSnapshot('data/session-lifecycle-v2-resume-start-replay.json');
    });

    it('does not replay any history when replayFrom is absent', async () => {
        const {connection, updates} = await connectV2Client({replayTurns});
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {sessionId, cwd});
        await waitForSessionUpdates(updates, ["available_commands_update", "session_info_update"]);

        expect(updates.some(({update}) => update.sessionUpdate.endsWith("_message_chunk")
            || update.sessionUpdate.endsWith("_message")
            || update.sessionUpdate === "tool_call")).toBe(false);
    });

    it('does not register session/load on v2', async () => {
        const {connection} = await connectV2Client();
        closeClient = () => connection.close();

        await expect(connection.agent.request("session/load", {sessionId, cwd, mcpServers: []}))
            .rejects.toMatchObject({code: -32601});
    });
});
