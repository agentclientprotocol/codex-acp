import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {type AcpClientConnection, ACPSessionConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

const usageUpdate: acp.SessionUpdate = {
    sessionUpdate: "usage_update",
    used: 1200,
    size: 200000,
    cost: {amount: 0.25, currency: "USD"},
};

const sessionInfoUpdate: acp.SessionUpdate = {
    sessionUpdate: "session_info_update",
    title: "Fix the build",
};

/** Connects a router and exposes the agent-side connection handle the router hands to the agent. */
function connectRouter() {
    const mocks = createMockConnections();
    let agentConnection: AcpClientConnection | AcpV2Connection | null = null;
    const router = createAcpAgentRouter((connection) => {
        agentConnection = connection;
        const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
        vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: true});
        return new CodexAcpServer(connection, codexAcpClient);
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
        clientStream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
        agentConnection: () => agentConnection!,
    };
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

describe('ACPSessionConnection - session/update over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    async function connectV2Client() {
        const {clientStream, agentConnection} = connectRouter();
        const received: unknown[] = [];
        const connection = acpV2.client({name: "test-client"})
            .onNotification(acpV2.methods.client.session.update, (ctx) => {
                checkV2SessionUpdate(ctx.params.update);
                received.push(ctx.params);
            })
            .connect(clientStream);
        closeClient = () => connection.close();
        await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
        });
        const handle = agentConnection();
        if (!(handle instanceof AcpV2Connection)) {
            throw new Error("expected the router to hand the agent a v2 connection");
        }
        return {received, view: handle.extensionOnlyV1View()};
    }

    it('delivers pass-through updates to a v2 client through the v2 binding', async () => {
        const {received, view} = await connectV2Client();
        const session = new ACPSessionConnection(view, "session-1");

        expect(session.protocolVersion).toBe(2);
        await session.update(usageUpdate);
        // Code that still calls `notify` on the connection directly takes the same v2 path.
        await view.notify(acp.methods.client.session.update, {sessionId: "session-1", update: sessionInfoUpdate});

        await vi.waitFor(() => expect(received).toHaveLength(2));
        await expect(dump(received)).toMatchFileSnapshot('data/session-update-v2-pass-through.json');
    });

    it('renders tool calls and agent chunks in the v2 shape', async () => {
        const {received, view} = await connectV2Client();
        const session = new ACPSessionConnection(view, "session-1");

        await session.update({sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run tests", kind: "execute", status: "pending"});
        await session.update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
            content: [{type: "content", content: {type: "text", text: "ok"}}],
        });
        await session.update({sessionUpdate: "tool_call_update", toolCallId: "call-1", content: null, locations: null});
        await session.update({sessionUpdate: "agent_message_chunk", messageId: "item-1", content: {type: "text", text: "hi"}});

        await vi.waitFor(() => expect(received).toHaveLength(4));
        await expect(dump(received)).toMatchFileSnapshot('data/session-update-v2-tool-calls-and-chunks.json');
    });

    it('fails loudly for updates whose v2 shape belongs to a later topic', async () => {
        const {received, view} = await connectV2Client();
        const session = new ACPSessionConnection(view, "session-1");

        await expect(session.update({
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Edit a.ts",
            content: [{type: "diff", path: "/workspace/a.ts", oldText: "a", newText: "b"}],
        })).rejects.toThrow("'diff' tool call content is not supported on an ACP v2 connection yet");
        await expect(view.notify(acp.methods.client.session.update, {
            sessionId: "session-1",
            update: {sessionUpdate: "tool_call_update", toolCallId: "call-2", _meta: {terminal_exit: {exit_code: 0}}},
        })).rejects.toThrow("Malformed 'terminal_exit' tool call metadata");
        await expect(session.update({
            sessionUpdate: "user_message_chunk",
            content: {type: "text", text: "hi"},
        })).rejects.toThrow("'user_message_chunk' session update without a messageId is not supported on an ACP v2 connection");

        // A later pass-through update is the first one the client sees.
        await session.update(usageUpdate);
        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received).toEqual([{sessionId: "session-1", update: usageUpdate}]);
    });

    it('keeps rejecting other standard methods on v2', async () => {
        const {view} = await connectV2Client();

        await expect(view.request(acp.methods.client.session.requestPermission, {
            sessionId: "session-1",
            toolCall: {toolCallId: "call-1"},
            options: [],
        })).rejects.toThrow("'session/request_permission' is not supported on an ACP v2 connection yet");
    });

    it('sends v1 updates unchanged over a v1 connection', async () => {
        const {clientStream, agentConnection} = connectRouter();
        const received: unknown[] = [];
        const connection = acp.client({name: "test-client"})
            .onNotification(acp.methods.client.session.update, (ctx) => {
                received.push(ctx.params);
            })
            .connect(clientStream);
        closeClient = () => connection.close();
        await connection.agent.request(acp.methods.agent.initialize, {protocolVersion: acp.PROTOCOL_VERSION});
        const handle = agentConnection();
        if (handle instanceof AcpV2Connection) {
            throw new Error("expected the router to hand the agent a v1 connection");
        }
        const session = new ACPSessionConnection(handle, "session-1");

        expect(session.protocolVersion).toBe(1);
        await session.update({sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run tests"});
        await session.update(usageUpdate);

        await vi.waitFor(() => expect(received).toHaveLength(2));
        await expect(dump(received)).toMatchFileSnapshot('data/session-update-v1-routed.json');
    });
});
