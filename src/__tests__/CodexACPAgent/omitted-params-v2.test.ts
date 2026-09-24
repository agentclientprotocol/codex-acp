import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type {AnyWireMessage} from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {createMockConnections} from './test-utils';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

/**
 * Raw JSON-RPC connection to the router. Unlike the typed `acpV2.client(...)` wrapper (which
 * always sends a `params` object), this writes wire items exactly as given, so tests can send a
 * request with `params` entirely absent.
 */
function connectRaw() {
    const mocks = createMockConnections();
    // `account/read` reports an already-authenticated API-key account, so `session/list` and
    // `auth/logout` don't hit the auth-required path.
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string) => {
        switch (method) {
            case "account/read":
                return {account: {type: "apiKey"}, requiresOpenaiAuth: true};
            case "thread/list":
                return {data: [], nextCursor: null};
            case "account/logout":
                // `logout()` awaits this notification before resolving.
                setImmediate(() => mocks.notificationHandlers.get("account/updated")?.({authMode: null, planType: null}));
                return {};
            default:
                return {};
        }
    });
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    const router = createAcpAgentRouter((connection) => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acpV2.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    const clientStream = acpV2.ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const writer = clientStream.writable.getWriter();
    const reader = clientStream.readable.getReader();
    return {
        send: (message: AnyWireMessage) => writer.write(message),
        /** Reads wire items until a response (or batch of responses) arrives, skipping notifications. */
        nextResponse: async (): Promise<AnyWireMessage> => {
            while (true) {
                const {value, done} = await reader.read();
                if (done) throw new Error("stream closed before a response arrived");
                const isResponse = Array.isArray(value)
                    ? value.every((item) => "id" in item && ("result" in item || "error" in item))
                    : "id" in value && ("result" in value || "error" in value);
                if (isResponse) return value;
            }
        },
        close: () => {
            void writer.close().catch(() => {});
        },
    };
}

async function initializeV2(raw: ReturnType<typeof connectRaw>) {
    await raw.send({
        jsonrpc: "2.0",
        id: "init",
        method: acpV2.methods.agent.initialize,
        params: {protocolVersion: 2, info: {name: "test-client", version: "1.0.0"}},
    });
    await raw.nextResponse();
}

async function initializeV1(raw: ReturnType<typeof connectRaw>) {
    await raw.send({
        jsonrpc: "2.0",
        id: "init",
        method: acp.methods.agent.initialize,
        params: {protocolVersion: 1},
    });
    await raw.nextResponse();
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/** Keeps only the fields that stay stable across SDK/zod versions. */
function errorShape(response: AnyWireMessage): unknown {
    const error = (response as {error?: {code: number}}).error;
    return error ? {code: error.code} : undefined;
}

describe('v2 requests with omitted params', () => {
    afterEach(() => {
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('accepts session/list with no params member', async () => {
        const raw = connectRaw();
        await initializeV2(raw);

        await raw.send({jsonrpc: "2.0", id: 1, method: acpV2.methods.agent.session.list});
        const response = await raw.nextResponse();

        await expect(dump(response)).toMatchFileSnapshot('data/omitted-params-v2-session-list.json');
    });

    it('accepts auth/logout with no params member', async () => {
        const raw = connectRaw();
        await initializeV2(raw);

        await raw.send({jsonrpc: "2.0", id: 1, method: acpV2.methods.agent.auth.logout});
        const response = await raw.nextResponse();

        await expect(dump(response)).toMatchFileSnapshot('data/omitted-params-v2-auth-logout.json');
    });

    it('fixes a batch entry that has no params member', async () => {
        const raw = connectRaw();
        await initializeV2(raw);

        await raw.send([
            {jsonrpc: "2.0", id: "a", method: acpV2.methods.agent.session.list},
            {jsonrpc: "2.0", id: "b", method: acpV2.methods.agent.session.list, params: {}},
        ] as unknown as AnyWireMessage);
        const response = await raw.nextResponse();

        expect(Array.isArray(response)).toBe(true);
        const errors = (response as unknown as Array<{id: unknown, error?: unknown}>)
            .map((entry) => ({id: entry.id, error: errorShape(entry as unknown as AnyWireMessage)}));
        expect(errors).toEqual([{id: "a", error: undefined}, {id: "b", error: undefined}]);
    });

    it('leaves params: null untouched (still rejected today)', async () => {
        const raw = connectRaw();
        await initializeV2(raw);

        await raw.send({jsonrpc: "2.0", id: 1, method: acpV2.methods.agent.session.list, params: null});
        const response = await raw.nextResponse();

        expect(errorShape(response)).toEqual({code: -32602});
    });

    it('still rejects session/new with no params (control: the fix is scoped to session/list and auth/logout)', async () => {
        const raw = connectRaw();
        await initializeV2(raw);

        await raw.send({jsonrpc: "2.0", id: 1, method: acpV2.methods.agent.session.new});
        const response = await raw.nextResponse();

        expect(errorShape(response)).toEqual({code: -32602});
    });

    it('v1 session/list with no params is unchanged (still rejected)', async () => {
        const raw = connectRaw();
        await initializeV1(raw);

        await raw.send({jsonrpc: "2.0", id: 1, method: acp.methods.agent.session.list});
        const response = await raw.nextResponse();

        expect(errorShape(response)).toEqual({code: -32602});
    });
});
