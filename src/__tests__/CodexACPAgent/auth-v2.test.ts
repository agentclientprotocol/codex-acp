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

const sessionId = "thread-1";
const cwd = "/workspace";

function createThread(): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "",
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
    };
}

/** Methods whose requests the snapshots record; the rest is session-setup noise. */
const recordedCodexMethods = new Set([
    "account/login/start",
    "account/logout",
    "thread/start",
]);

/**
 * Connects a v2 client to the agent through the router, over a mocked Codex app-server
 * whose account starts logged out. An API key login succeeds unless `loginSucceeds` is false.
 */
async function connectV2Client(options: {loginSucceeds?: boolean} = {}) {
    const loginSucceeds = options.loginSucceeds ?? true;
    const mocks = createMockConnections();
    const codexRequests: Array<{method: string, params: unknown}> = [];
    let loggedIn = false;
    // Codex answers a login or logout request first, then pushes the outcome.
    const pushNotification = (method: string, params: unknown) => setImmediate(() => {
        mocks.notificationHandlers.get(method)?.(params);
    });
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
        if (recordedCodexMethods.has(method)) {
            codexRequests.push({method, params});
        }
        switch (method) {
            case "account/read":
                return {
                    account: loggedIn ? {type: "apiKey"} : null,
                    requiresOpenaiAuth: true,
                };
            case "account/login/start":
                loggedIn = loginSucceeds;
                pushNotification("account/login/completed", {
                    loginId: null,
                    success: loginSucceeds,
                    error: loginSucceeds ? null : "invalid key",
                    onboardingEntrypoint: null,
                });
                return {type: "apiKey"};
            case "account/logout":
                loggedIn = false;
                pushNotification("account/updated", {authMode: null, planType: null});
                return {};
            case "thread/start":
                return {
                    thread: createThread(),
                    model: "gpt-5",
                    modelProvider: "openai",
                    reasoningEffort: "medium",
                    serviceTier: null,
                    turnsBackwardsCursor: null,
                };
            case "model/list":
                return {data: [createTestModel({id: "gpt-5"})], nextCursor: null};
            case "skills/list":
                return {data: []};
            case "config/read":
                return {config: {}, origins: {}, layers: []};
            case "thread/goal/get":
                return {goal: null};
            default:
                return {};
        }
    });
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue({ready: [], failed: [], cancelled: []});
    const router = createAcpAgentRouter((connection) => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const connection = acpV2.client({name: "test-client"})
        .onNotification(acpV2.methods.client.session.update, () => {})
        .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: {name: "test-client", version: "1.0.0"},
    });
    return {connection, codexRequests};
}

function toError(err: {code: number, message: string, data?: unknown}) {
    return {code: err.code, message: err.message, data: err.data};
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

const apiKeyLogin: acpV2.LoginAuthRequest = {
    methodId: "api-key",
    _meta: {"api-key": {apiKey: "sk-test"}},
};

describe('Auth over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    it('requires auth for session/new, then creates the session after auth/login', async () => {
        const {connection, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();

        const authRequired = await connection.agent.request(acpV2.methods.agent.session.new, {cwd})
            .then(() => null, toError);
        const login = await connection.agent.request(acpV2.methods.agent.auth.login, apiKeyLogin);
        const session = await connection.agent.request(acpV2.methods.agent.session.new, {cwd});

        expect(authRequired?.code).toBe(-32000);
        expect(session.sessionId).toBe(sessionId);
        await expect(dump({authRequired, login, codexRequests}))
            .toMatchFileSnapshot('data/auth-v2-login-then-new-session.json');
    });

    it('rejects auth/login when the Codex login fails', async () => {
        const {connection, codexRequests} = await connectV2Client({loginSucceeds: false});
        closeClient = () => connection.close();

        const error = await connection.agent.request(acpV2.methods.agent.auth.login, apiKeyLogin)
            .then(() => null, toError);

        await expect(dump({error, codexRequests})).toMatchFileSnapshot('data/auth-v2-login-failed.json');
    });

    it('logs out with auth/logout', async () => {
        const {connection, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();
        await connection.agent.request(acpV2.methods.agent.auth.login, apiKeyLogin);
        codexRequests.splice(0);

        const logout = await connection.agent.request(acpV2.methods.agent.auth.logout, {});
        const authRequired = await connection.agent.request(acpV2.methods.agent.session.new, {cwd})
            .then(() => null, toError);

        expect(authRequired?.code).toBe(-32000);
        await expect(dump({logout, codexRequests})).toMatchFileSnapshot('data/auth-v2-logout.json');
    });

    it('does not answer the v1 auth method names', async () => {
        const {connection, codexRequests} = await connectV2Client();
        closeClient = () => connection.close();

        const errors: Record<string, unknown> = {};
        for (const method of ["authenticate", "logout", "authentication/status", "authentication/logout"]) {
            errors[method] = await connection.agent.request(method as `_${string}`, {methodId: "api-key"})
                .then(() => null, toError);
        }

        expect(codexRequests).toEqual([]);
        await expect(dump(errors)).toMatchFileSnapshot('data/auth-v2-v1-method-names.json');
    });
});
