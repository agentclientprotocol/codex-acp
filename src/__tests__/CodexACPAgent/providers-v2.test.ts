import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient, OPENAI_PROVIDER_ID} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {createMockConnections} from './test-utils';

type ProtocolVersion = "v1" | "v2";

/**
 * Connects a v1 or v2 client to the agent through the router, over a mocked Codex app-server.
 * `providers/*` never touches a live session in these tests, so the mock just needs to exist.
 */
function connectClient(version: ProtocolVersion) {
    const mocks = createMockConnections();
    mocks.mockCodexConnection.sendRequest.mockResolvedValue({});
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    const router = createAcpAgentRouter((connection) => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    const clientStream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);

    if (version === "v1") {
        const connection = acp.client({name: "test-client"}).connect(clientStream);
        return {
            connection,
            initialize: () => connection.agent.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
            }),
            providers: {
                list: (params: acp.ListProvidersRequest) =>
                    connection.agent.request(acp.methods.agent.providers.list, params),
                set: (params: acp.SetProviderRequest) =>
                    connection.agent.request(acp.methods.agent.providers.set, params),
                disable: (params: acp.DisableProviderRequest) =>
                    connection.agent.request(acp.methods.agent.providers.disable, params),
            },
        };
    }

    const connection = acpV2.client({name: "test-client"}).connect(clientStream);
    return {
        connection,
        initialize: () => connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
        }),
        providers: {
            list: (params: acpV2.ListProvidersRequest) =>
                connection.agent.request(acpV2.methods.agent.providers.list, params),
            set: (params: acpV2.SetProviderRequest) =>
                connection.agent.request(acpV2.methods.agent.providers.set, params),
            disable: (params: acpV2.DisableProviderRequest) =>
                connection.agent.request(acpV2.methods.agent.providers.disable, params),
        },
    };
}

function toError(err: {code: number, message: string, data?: unknown}) {
    return {code: err.code, message: err.message, data: err.data};
}

const VERSIONS: ProtocolVersion[] = ["v1", "v2"];

describe('providers/* over ACP v1 and v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    it.each(VERSIONS)('%s: lists native OpenAI routing before any override', async (version) => {
        const client = connectClient(version);
        closeClient = () => client.connection.close();
        await client.initialize();

        const response = await client.providers.list({});

        expect(response).toEqual({
            providers: [{
                providerId: OPENAI_PROVIDER_ID,
                supported: ["openai"],
                required: false,
                current: {apiType: "openai", baseUrl: "https://api.openai.com/v1"},
            }],
        });
    });

    it.each(VERSIONS)('%s: reflects set routing in list without echoing headers', async (version) => {
        const client = connectClient(version);
        closeClient = () => client.connection.close();
        await client.initialize();

        const setResponse = await client.providers.set({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
            headers: {Authorization: "Bearer super-secret"},
        });
        const listResponse = await client.providers.list({});

        expect(setResponse).toEqual({});
        const provider = listResponse.providers[0]!;
        expect(provider.current).toEqual({
            apiType: "openai",
            baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
        });
        expect(JSON.stringify(provider)).not.toContain("super-secret");
    });

    it.each(VERSIONS)('%s: restores native OpenAI routing after disable', async (version) => {
        const client = connectClient(version);
        closeClient = () => client.connection.close();
        await client.initialize();
        await client.providers.set({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://example.com/v1",
        });

        const disableResponse = await client.providers.disable({providerId: OPENAI_PROVIDER_ID});
        const listResponse = await client.providers.list({});

        expect(disableResponse).toEqual({});
        expect(listResponse.providers[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://api.openai.com/v1",
        });
    });

    it.each(VERSIONS)('%s: treats disabling an unknown providerId as idempotent success', async (version) => {
        const client = connectClient(version);
        closeClient = () => client.connection.close();
        await client.initialize();

        const disableResponse = await client.providers.disable({providerId: "not-a-real-provider"});

        expect(disableResponse).toEqual({});
    });

    it.each(VERSIONS)('%s: rejects an unsupported apiType with invalid_params', async (version) => {
        const client = connectClient(version);
        closeClient = () => client.connection.close();
        await client.initialize();

        const error = await client.providers.set({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "anthropic",
            baseUrl: "https://example.com",
        } as never).then(() => null, toError);

        expect(error?.code).toBe(-32602);
    });

    it.each(VERSIONS)('%s: rejects an unknown providerId with invalid_params', async (version) => {
        const client = connectClient(version);
        closeClient = () => client.connection.close();
        await client.initialize();

        const error = await client.providers.set({
            providerId: "does-not-exist",
            apiType: "openai",
            baseUrl: "https://example.com",
        }).then(() => null, toError);

        expect(error?.code).toBe(-32602);
    });

    // The v2 SDK validates `baseUrl` as `format: uri` before codex-acp's own handler runs.
    // v1's schema has no such format constraint, so v1's handler-level check (non-empty string
    // only) is all that applies there.
    it('v2 only: rejects a non-URL baseUrl with invalid_params from the SDK', async () => {
        const client = connectClient("v2");
        closeClient = () => client.connection.close();
        await client.initialize();

        const error = await client.providers.set({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "not-a-url",
        }).then(() => null, toError);

        expect(error?.code).toBe(-32602);
    });

    it('v1 pin: accepts a non-URL baseUrl (no format validation on v1)', async () => {
        const client = connectClient("v1");
        closeClient = () => client.connection.close();
        await client.initialize();

        const setResponse = await client.providers.set({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "not-a-url",
        });
        const listResponse = await client.providers.list({});

        expect(setResponse).toEqual({});
        expect(listResponse.providers[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "not-a-url",
        });
    });
});
