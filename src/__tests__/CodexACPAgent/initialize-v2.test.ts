import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {z} from 'zod';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {toV1ClientCapabilitiesView} from '../../AcpV2ClientCapabilities';
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY, clientSupportsAirCapability} from '../../AirExtension';
import {AcpV2Connection} from '../../ACPSessionConnection';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {clientSupportsFormElicitation, clientSupportsUrlElicitation} from '../../ElicitationCapabilities';
import {createMockConnections} from './test-utils';

const v2ClientCapabilities: acpV2.ClientCapabilities = {
    auth: {
        terminal: {},
        _meta: {gateway: true},
    },
    elicitation: {form: {}, url: {}},
    _meta: {
        jetbrains: {
            air: {
                version: 1,
                capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY],
            },
        },
    },
};

function connectRouter() {
    const mocks = createMockConnections();
    const router = createAcpAgentRouter((connection) => {
        const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
        vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: true});
        return new CodexAcpServer(connection, codexAcpClient);
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
        mocks,
        clientStream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
    };
}

/** The agent version changes on every release; keep snapshots stable. */
function withStableVersion<T extends object>(response: T, infoKey: "info" | "agentInfo"): T {
    const info = (response as Record<string, any>)[infoKey];
    return {...response, [infoKey]: {...info, version: "<version>"}};
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

describe('CodexACPAgent - initialize over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    beforeEach(() => {
        closeClient = null;
    });

    afterEach(() => {
        closeClient?.();
        vi.clearAllMocks();
    });

    it('routes a v2 initialize to the v2 chain and returns the v2 capability shape', async () => {
        const {clientStream} = connectRouter();
        const authStatusUpdates: unknown[] = [];
        const connection = acpV2.client({name: "test-client"})
            .onNotification("_auth/status_update", z.object({}).passthrough(), (ctx) => {
                authStatusUpdates.push(ctx.params);
            })
            .connect(clientStream);
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
            capabilities: v2ClientCapabilities,
        });

        await expect(dump(withStableVersion(response, "info"))).toMatchFileSnapshot(
            'data/initialize-v2-response.json'
        );
        // Extension notifications still reach a v2 client before any v2 send path exists.
        await vi.waitFor(() => expect(authStatusUpdates).toHaveLength(1));
    });

    it('advertises only the auth methods the v2 client capabilities allow', async () => {
        const {clientStream} = connectRouter();
        const connection = acpV2.client({name: "test-client"}).connect(clientStream);
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
        });

        const methodIds = response.authMethods?.map((method) => method.methodId);
        expect(methodIds).not.toContain("gateway");
        expect(methodIds).not.toContain("chat-gpt-device-code");
    });

    it('still routes a v1 initialize to the unchanged v1 chain', async () => {
        const {clientStream} = connectRouter();
        const connection = acp.client({name: "test-client"}).connect(clientStream);
        closeClient = () => connection.close();

        const response = await connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {auth: {_meta: {gateway: true}}},
        });

        await expect(dump(withStableVersion(response, "agentInfo"))).toMatchFileSnapshot(
            'data/initialize-v1-routed-response.json'
        );
    });
});

describe('ACP v2 client capability normalization', () => {
    it('keeps the fields existing readers probe at the same relative path', async () => {
        const view = toV1ClientCapabilitiesView(v2ClientCapabilities);

        await expect(dump(view)).toMatchFileSnapshot('data/initialize-v2-client-capabilities-view.json');
        expect(clientSupportsFormElicitation(view)).toBe(true);
        expect(clientSupportsUrlElicitation(view)).toBe(true);
        expect(view?.auth?._meta?.["gateway"]).toBe(true);
        expect(clientSupportsAirCapability(view, AIR_NATIVE_SUBAGENT_SESSIONS_KEY)).toBe(true);
    });

    it('reports nothing supported when the v2 client sends no capabilities', () => {
        const view = toV1ClientCapabilitiesView(undefined);

        expect(view).toBeNull();
        expect(clientSupportsFormElicitation(view)).toBe(false);
        expect(clientSupportsUrlElicitation(view)).toBe(false);
        expect(clientSupportsAirCapability(view, AIR_NATIVE_SUBAGENT_SESSIONS_KEY)).toBe(false);
    });
});

describe('ACP v2 connection before the v2 send path exists', () => {
    it('forwards extension methods and rejects v1-shaped standard methods', async () => {
        const client = {notify: vi.fn().mockResolvedValue(undefined), request: vi.fn().mockResolvedValue({})};
        const view = new AcpV2Connection(client as any).extensionOnlyV1View();

        await view.notify("_auth/status_update", {authStatus: {kind: "none"}});
        await expect(view.request(acp.methods.client.session.requestPermission, {
            sessionId: "session",
            toolCall: {toolCallId: "call-1"},
            options: [],
        })).rejects.toThrow("'session/request_permission' is not supported on an ACP v2 connection yet");

        expect(client.notify.mock.calls).toEqual([["_auth/status_update", {authStatus: {kind: "none"}}]]);
    });
});
