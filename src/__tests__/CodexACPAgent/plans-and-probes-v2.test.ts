import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {toV2SessionUpdate} from '../../AcpV2SessionUpdate';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ServerNotification} from '../../app-server';
import type {Turn} from '../../app-server/v2';
import {createTestSessionState} from '../acp-test-utils';
import {createMockConnections} from './test-utils';

const sessionId = "session-1";
const turnId = "turn-1";

const availableCommandsUpdate: acp.SessionUpdate = {
    sessionUpdate: "available_commands_update",
    availableCommands: [
        {name: "review", description: "Review changes", input: {hint: "focus"}, _meta: {kind: "hint"}},
        {name: "status", description: "Show status", input: null},
        {name: "compact", description: "Compact the thread"},
    ],
};

function createTurn(status: Turn["status"]): Turn {
    return {id: turnId, items: [], itemsView: "full", status, error: null, startedAt: null, completedAt: null, durationMs: null};
}

/**
 * Connects a v2 client that declares no capabilities. Sessions can't be created or prompted
 * over v2 yet, so the test registers session state and runs a prompt on the agent directly;
 * its updates still go out through the v2 connection.
 */
async function connectV2Client() {
    const mocks = createMockConnections();
    const appServer = new CodexAppServerClient(mocks.mockCodexConnection as any);
    const codexAcpClient = new CodexAcpClient(appServer);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: true});
    vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: createTurn("inProgress")});
    vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({threadId: sessionId, turn: createTurn("completed")});
    let agent: CodexAcpServer | null = null;
    let agentConnection: unknown = null;
    const router = createAcpAgentRouter((connection) => {
        agentConnection = connection;
        agent = new CodexAcpServer(connection, codexAcpClient);
        return agent;
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const updates: acpV2.UpdateSessionNotification[] = [];
    const connection = acpV2.client({name: "test-client"})
        .onNotification(acpV2.methods.client.session.update, (ctx) => {
            updates.push(ctx.params);
        })
        .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: {name: "test-client", version: "1.0.0"},
    });
    if (!(agentConnection instanceof AcpV2Connection)) {
        throw new Error("expected the router to hand the agent a v2 connection");
    }
    const view = agentConnection.extensionOnlyV1View();

    async function startPrompt() {
        vi.spyOn(agent!, "getSessionState").mockReturnValue(createTestSessionState({sessionId}));
        await agent!.prompt({sessionId, prompt: [{type: "text", text: "Continue."}]});
        updates.splice(0);
    }

    async function send(notifications: ServerNotification[]) {
        for (const notification of notifications) {
            mocks.getUnhandledNotificationHandler()!(notification);
        }
        await codexAcpClient.waitForSessionNotifications(sessionId);
    }

    return {connection, updates, view, startPrompt, send};
}

function planUpdated(steps: {step: string, status: "pending" | "inProgress" | "completed"}[]): ServerNotification {
    return {method: "turn/plan/updated", params: {threadId: sessionId, turnId, explanation: null, plan: steps}};
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

describe('Plans, compaction, notices and commands over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    it('sends the structured plan as an items plan_update with a stable planId', async () => {
        const {connection, updates, startPrompt, send} = await connectV2Client();
        closeClient = () => connection.close();
        await startPrompt();

        await send([
            planUpdated([{step: "Add the mapping", status: "inProgress"}, {step: "Verify it", status: "pending"}]),
            planUpdated([{step: "Add the mapping", status: "completed"}, {step: "Verify it", status: "inProgress"}]),
        ]);

        await vi.waitFor(() => expect(updates).toHaveLength(2));
        const planIds = updates.map(({update}) => update.sessionUpdate === "plan_update"
            ? (update as acpV2.PlanUpdate).plan.planId
            : null);
        expect(planIds[0]).toEqual(expect.any(String));
        expect(planIds[1]).toBe(planIds[0]);
        await expect(dump(updates)).toMatchFileSnapshot('data/plans-v2-structured.json');
    });

    it('sends the narrative plan as a markdown plan_update without a plan capability', async () => {
        const {connection, updates, startPrompt, send} = await connectV2Client();
        closeClient = () => connection.close();
        await startPrompt();

        const item = {type: "plan" as const, id: "plan-item-1", text: ""};
        await send([
            {method: "item/started", params: {threadId: sessionId, turnId, startedAtMs: 0, item}},
            {method: "item/plan/delta", params: {threadId: sessionId, turnId, itemId: item.id, delta: "1. Add the mapping."}},
            {method: "item/completed", params: {threadId: sessionId, turnId, completedAtMs: 1, item}},
        ]);

        await vi.waitFor(() => expect(updates).toHaveLength(1));
        await expect(dump(updates)).toMatchFileSnapshot('data/plans-v2-markdown.json');
    });

    it('sends compaction and notice updates without client capabilities', async () => {
        const {connection, updates, startPrompt, send} = await connectV2Client();
        closeClient = () => connection.close();
        await startPrompt();

        const item = {type: "contextCompaction" as const, id: "compaction-1"};
        await send([
            {method: "item/started", params: {threadId: sessionId, turnId, startedAtMs: 0, item}},
            {method: "item/completed", params: {threadId: sessionId, turnId, completedAtMs: 1, item}},
            {method: "warning", params: {threadId: sessionId, message: "Optional integration unavailable"}},
        ]);

        await vi.waitFor(() => expect(updates).toHaveLength(3));
        await expect(dump(updates)).toMatchFileSnapshot('data/plans-v2-compaction-and-notice.json');
    });

    it('tags command input as text so a v2 client keeps it', async () => {
        const {connection, updates, view} = await connectV2Client();
        closeClient = () => connection.close();

        await new ACPSessionConnection(view, sessionId).update(availableCommandsUpdate);

        await vi.waitFor(() => expect(updates).toHaveLength(1));
        expect(updates[0]!.update.sessionUpdate).toBe("available_commands_update");
        const {availableCommands} = updates[0]!.update as acpV2.AvailableCommandsUpdate;
        // A v2 client's parser drops an untagged input, so the tag must arrive.
        expect(availableCommands.map((command) => command.input)).toEqual([
            {type: "text", hint: "focus"},
            null,
            undefined,
        ]);
        expect("input" in availableCommands[2]!).toBe(false);
        await expect(dump(updates)).toMatchFileSnapshot('data/available-commands-v2-received.json');
        await expect(dump(toV2SessionUpdate(availableCommandsUpdate)))
            .toMatchFileSnapshot('data/available-commands-v2-rendered.json');
    });
});
