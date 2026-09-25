import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {AgentMode, MODE_CONFIG_ID} from '../../AgentMode';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {FAST_MODE_CONFIG_ID} from '../../FastModeConfig';
import type {ReasoningEffortOption} from '../../app-server/v2';
import {createTestModel, createTestSessionState} from '../acp-test-utils';
import {createMockConnections} from './test-utils';

const lowEffort: ReasoningEffortOption = {reasoningEffort: "low", description: "Fast"};
const mediumEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Balanced"};

function createSessionState() {
    const fast = createTestModel({
        id: "fast-model",
        displayName: "Fast model",
        description: "Frontier",
        supportedReasoningEfforts: [lowEffort, mediumEffort],
        additionalSpeedTiers: ["fast"],
    });
    const slow = createTestModel({id: "slow-model", displayName: "Slow model", isDefault: false});
    return createTestSessionState({
        sessionId: "session-1",
        currentModelId: "fast-model[medium]",
        availableModels: [fast, slow],
        supportedReasoningEfforts: [lowEffort, mediumEffort],
        currentModelSupportsFast: true,
    });
}

/**
 * Connects a v2 client through the router. Sessions can't be created over v2 yet, so the test
 * registers session state on the agent directly.
 */
async function connectV2Client() {
    const mocks = createMockConnections();
    let agent: CodexAcpServer | null = null;
    let agentConnection: unknown = null;
    const router = createAcpAgentRouter((connection) => {
        agentConnection = connection;
        const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
        vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: true});
        agent = new CodexAcpServer(connection, codexAcpClient);
        return agent;
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const updates: unknown[] = [];
    const connection = acpV2.client({name: "test-client"})
        .onNotification(acpV2.methods.client.session.update, (ctx) => {
            updates.push(ctx.params);
        })
        .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: {name: "test-client", version: "1.0.0"},
    });

    const sessionState = createSessionState();
    // @ts-expect-error - register a session without a v2 `session/new`
    agent!.sessions.set(sessionState.sessionId, sessionState);
    if (!(agentConnection instanceof AcpV2Connection)) {
        throw new Error("expected the router to hand the agent a v2 connection");
    }
    return {connection, agent: agent!, sessionState, updates, view: agentConnection.extensionOnlyV1View()};
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

describe('Session config options over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    it('builds the v2 config option list with configId and a boolean fast-mode option', async () => {
        const {connection, agent, sessionState} = await connectV2Client();
        closeClient = () => connection.close();

        // @ts-expect-error - private method, called directly to test the response shape in isolation
        const response = agent.createSessionConfigOptionsResponseV2(sessionState);

        await expect(dump(response)).toMatchFileSnapshot('data/session-config-options-v2-list.json');
    });

    it('sends config_option_update in the v2 shape', async () => {
        const {connection, agent, sessionState, updates, view} = await connectV2Client();
        closeClient = () => connection.close();
        const session = new ACPSessionConnection(view, sessionState.sessionId);

        await session.update({
            sessionUpdate: "config_option_update",
            configOptions: [
                // @ts-expect-error - the list the agent sends with every config_option_update
                ...agent.createSessionConfigOptions(sessionState),
                {
                    id: "grouped",
                    name: "Grouped",
                    type: "select",
                    currentValue: "a",
                    options: [{group: "letters", name: "Letters", options: [{value: "a", name: "A"}]}],
                },
            ],
        });

        await vi.waitFor(() => expect(updates).toHaveLength(1));
        await expect(dump(updates)).toMatchFileSnapshot('data/session-config-options-v2-update.json');
    });

    it('rejects current_mode_update on v2', async () => {
        const {connection, updates, view} = await connectV2Client();
        closeClient = () => connection.close();
        const session = new ACPSessionConnection(view, "session-1");

        await expect(session.update({sessionUpdate: "current_mode_update", currentModeId: "agent"}))
            .rejects.toThrow("'current_mode_update' session update does not exist in ACP v2");
        expect(updates).toEqual([]);
    });

    it('applies session/set_config_option and answers with v2 config options', async () => {
        const {connection, sessionState} = await connectV2Client();
        closeClient = () => connection.close();

        const fastModeResponse = await connection.agent.request(acpV2.methods.agent.session.setConfigOption, {
            sessionId: sessionState.sessionId,
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: true,
        });
        const modeResponse = await connection.agent.request(acpV2.methods.agent.session.setConfigOption, {
            sessionId: sessionState.sessionId,
            configId: MODE_CONFIG_ID,
            type: "id",
            value: AgentMode.ReadOnly.id,
        });

        expect(sessionState.fastModeEnabled).toBe(true);
        expect(sessionState.agentMode).toBe(AgentMode.ReadOnly);
        await expect(dump({fastModeResponse, modeResponse}))
            .toMatchFileSnapshot('data/session-config-options-v2-set.json');
    });

    it('rejects a set_config_option value that does not match its type', async () => {
        const {connection, sessionState} = await connectV2Client();
        closeClient = () => connection.close();

        await expect(connection.agent.request(acpV2.methods.agent.session.setConfigOption, {
            sessionId: sessionState.sessionId,
            configId: MODE_CONFIG_ID,
            type: "boolean",
            value: true,
        })).rejects.toMatchObject({code: -32602});
        await expect(connection.agent.request(acpV2.methods.agent.session.setConfigOption, {
            sessionId: sessionState.sessionId,
            configId: FAST_MODE_CONFIG_ID,
            type: "_custom",
            value: true,
        })).rejects.toMatchObject({code: -32602});
        expect(sessionState.agentMode).toBe(AgentMode.DEFAULT_AGENT_MODE);
        expect(sessionState.fastModeEnabled).toBe(false);
    });

    it('does not register session/set_mode on v2', async () => {
        const {connection, sessionState} = await connectV2Client();
        closeClient = () => connection.close();

        await expect(connection.agent.request("session/set_mode", {
            sessionId: sessionState.sessionId,
            modeId: AgentMode.ReadOnly.id,
        })).rejects.toMatchObject({code: -32601});
    });
});
