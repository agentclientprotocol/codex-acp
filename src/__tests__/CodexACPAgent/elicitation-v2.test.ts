import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {McpServerElicitationRequestParams} from '../../app-server/v2';
import {
    sessionId,
    turnId,
    connectSession,
    userMessageItem,
    itemCompleted,
    turnStarted,
    turnCompleted,
    turnFinished,
    settle,
    stateUpdates,
    dump,
    type PromptSession,
    type TranscriptEntry,
} from './v2-prompt-harness';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

/**
 * Starts a prompt and lets its turn actually start (`turn/started` emitted) before returning, so
 * an MCP elicitation triggered against it finds a real turn running -- matching how the MCP OAuth
 * re-auth flow only ever fires mid-turn -- and its trailing `running` fires once it settles.
 */
async function startRunningPrompt(client: PromptSession) {
    client.setTurnStart(async () => ({
        turn: {id: turnId, items: [], itemsView: "notLoaded" as const, status: "inProgress" as const, error: null, startedAt: null, completedAt: null, durationMs: null},
    }));
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    return {
        response,
        clientUserMessageId,
        finishTurn: async () => {
            client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
            await response;
            client.emit(turnCompleted());
            await client.promptRunFinished();
        },
    };
}

function oauthReauthParams(overrides: Partial<McpServerElicitationRequestParams & {mode: "url"}> = {}): McpServerElicitationRequestParams {
    return {
        threadId: sessionId,
        turnId,
        serverName: "auth-server",
        mode: "url",
        _meta: null,
        message: "Please authorize access",
        url: "https://example.com/authorize",
        elicitationId: "elicit-123",
        ...overrides,
    };
}

describe('elicitation/create over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('sends the MCP OAuth re-auth URL elicitation on the real v2 send path and accepts it', async () => {
        const client = await connectSession(2, {
            clientCapabilities: {elicitation: {url: {}}},
            onElicitation: async () => ({action: "accept", content: null, _meta: {source: "client"}}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startRunningPrompt(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval('mcpServer/elicitation/request', oauthReauthParams());

        expect(response).toEqual({action: "accept", content: null, _meta: {source: "client"}});
        const transcript = client.transcript.slice(start);
        const elicitationRequests = transcript.flatMap(entry => "elicitationRequest" in entry ? [entry.elicitationRequest] : []);
        expect(elicitationRequests).toEqual([{
            sessionId,
            mode: "url",
            message: "Please authorize access",
            url: "https://example.com/authorize",
            elicitationId: "elicit-123",
            _meta: null,
        }]);
        // The turn is running when the elicitation fires, so its trailing `running` closes the
        // `requires_action` bracket once the client answers (mirrors `session/request_permission`).
        expect(stateUpdates(transcript)).toEqual([{state: "requires_action"}, {state: "running"}]);
        await expect(dump(transcript)).toMatchFileSnapshot('data/elicitation-v2-oauth-reauth-accepted.json');

        // Codex reports the underlying MCP server request as resolved once the OAuth flow lands;
        // a URL elicitation only completes then (see `CodexElicitationHandler`).
        client.emit({method: "serverRequest/resolved", params: {threadId: sessionId, requestId: "request-1"}});
        await settle();
        expect(client.transcript.slice(start).at(-1)).toEqual({elicitationComplete: {elicitationId: "elicit-123"}});

        await finishTurn();
    });

    it('declines the MCP OAuth re-auth elicitation', async () => {
        const client = await connectSession(2, {
            clientCapabilities: {elicitation: {url: {}}},
            onElicitation: async () => ({action: "decline", _meta: null}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startRunningPrompt(client);

        const response = await client.triggerApproval('mcpServer/elicitation/request', oauthReauthParams());

        expect(response).toEqual({action: "decline", content: null, _meta: null});
        await finishTurn();
    });

    it('cancels the MCP OAuth re-auth elicitation when the client dismisses it', async () => {
        const client = await connectSession(2, {
            clientCapabilities: {elicitation: {url: {}}},
            onElicitation: async () => ({action: "cancel"}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startRunningPrompt(client);

        const response = await client.triggerApproval('mcpServer/elicitation/request', oauthReauthParams());

        expect(response).toEqual({action: "cancel", content: null, _meta: null});
        await finishTurn();
    });

    it('falls back to session/request_permission when the client has no url elicitation capability', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "selected", optionId: "accept"}}),
        });
        closeClient = () => client.connection.close();
        const {finishTurn} = await startRunningPrompt(client);
        const start = client.transcript.length;

        const response = await client.triggerApproval('mcpServer/elicitation/request', oauthReauthParams());

        expect(response).toEqual({action: "accept", content: null, _meta: null});
        const transcript = client.transcript.slice(start);
        expect(transcript.some(entry => "elicitationRequest" in entry)).toBe(false);
        expect(transcript.some(entry => "permissionRequest" in entry)).toBe(true);

        await finishTurn();
    });

    it('aborts a pending MCP elicitation on session/cancel', async () => {
        const elicitation = deferred<acpV2.CreateElicitationResponse>();
        let capturedSignal: AbortSignal | undefined;
        const client = await connectSession(2, {
            clientCapabilities: {elicitation: {url: {}}},
            onElicitation: async (_request, signal) => {
                capturedSignal = signal;
                return elicitation.promise;
            },
        });
        closeClient = () => client.connection.close();
        const {response, clientUserMessageId} = await startRunningPrompt(client);
        const start = client.transcript.length;

        const elicitationPromise = client.triggerApproval('mcpServer/elicitation/request', oauthReauthParams());
        await vi.waitFor(() => expect(capturedSignal).toBeDefined());
        expect(capturedSignal!.aborted).toBe(false);

        await client.cancel();
        await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));

        // A conforming client answers `cancel` once it has seen `session/cancel`.
        elicitation.resolve({action: "cancel"});
        expect(await elicitationPromise).toEqual({action: "cancel", content: null, _meta: null});

        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        client.emit(turnFinished("interrupted"));
        await response;
        await client.promptRunFinished();
        await settle();

        // The trailing extra `running` (before settling to `idle`) reflects a late elicitation
        // answer arriving after cancellation; this mirrors the analogous permission-request test.
        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([
            {state: "requires_action"},
            {state: "running"},
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);
    });

    /**
     * `chat-gpt-device-code` login has no session, so it can't use the v2 prompt harness (which
     * always opens one). This mirrors `auth-v2.test.ts`'s bespoke connection setup instead, adding
     * elicitation wiring.
     */
    async function connectAuthClient(onElicitation: (request: acpV2.CreateElicitationRequest, signal: AbortSignal) => acpV2.CreateElicitationResponse | Promise<acpV2.CreateElicitationResponse>) {
        const mocks = createMockConnections();
        const transcript: TranscriptEntry[] = [];
        mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string) => {
            switch (method) {
                case "account/read":
                    return {account: null, requiresOpenaiAuth: true};
                case "account/login/start":
                    return {
                        type: "chatgptDeviceCode",
                        loginId: "login-1",
                        verificationUrl: "https://auth.example.com/device",
                        userCode: "ABC-123",
                    };
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
            .onNotification(acpV2.methods.client.session.update, (ctx) => checkV2SessionUpdate(ctx.params.update))
            .onRequest(acpV2.methods.client.elicitation.create, async (ctx) => {
                transcript.push({elicitationRequest: ctx.params});
                return await onElicitation(ctx.params, ctx.signal);
            })
            .onNotification(acpV2.methods.client.elicitation.complete, (ctx) => {
                transcript.push({elicitationComplete: ctx.params});
            })
            .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
        await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
            capabilities: {elicitation: {url: {}}},
        });
        return {connection, transcript, mocks};
    }

    it('completes the chat-gpt-device-code login end to end via elicitation/create', async () => {
        const {connection, transcript, mocks} = await connectAuthClient(
            async () => ({action: "accept", content: null, _meta: null}),
        );
        closeClient = () => connection.close();

        const login = connection.agent.request(acpV2.methods.agent.auth.login, {methodId: "chat-gpt-device-code"} as acpV2.LoginAuthRequest);

        await vi.waitFor(() => expect(transcript.some(entry => "elicitationRequest" in entry)).toBe(true));
        const elicitationRequest = transcript.flatMap(entry => "elicitationRequest" in entry ? [entry.elicitationRequest] : []).at(-1)!;
        expect(elicitationRequest).toEqual({
            requestId: expect.anything(),
            mode: "url",
            url: "https://auth.example.com/device",
            message: "Sign in to ChatGPT and enter this code: ABC-123",
            elicitationId: "login-1",
        });
        // A request-scoped elicitation (no session exists yet) must not send `state_update`.
        expect(stateUpdates(transcript)).toEqual([]);

        mocks.notificationHandlers.get("account/login/completed")?.({
            loginId: "login-1", success: true, error: null, onboardingEntrypoint: null,
        });

        await expect(login).resolves.toEqual({});
        await settle();
        expect(transcript.some(entry => "elicitationComplete" in entry
            && entry.elicitationComplete.elicitationId === "login-1")).toBe(true);
    });
});
