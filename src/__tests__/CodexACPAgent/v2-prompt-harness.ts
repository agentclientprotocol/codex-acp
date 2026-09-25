import {expect, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ServerNotification} from '../../app-server';
import type {Thread, ThreadItem, Turn, TurnStatus} from '../../app-server/v2';
import type {McpStartupResult} from '../../CodexAppServerClient';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate} from './v2-session-update-guard';

export const sessionId = "thread-1";
export const turnId = "turn-1";
export const cwd = "/workspace";
export const titleThreadId = "title-thread";

export function createThread(): Thread {
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

export function createTurn(status: TurnStatus, id = turnId): Turn {
    return {
        id,
        items: [],
        itemsView: "notLoaded",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

/** Canned Codex app-server responses, keyed by method. */
export function codexResponse(method: string): unknown {
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
}

/** The client-visible transcript of a prompt, in wire order. */
export type TranscriptEntry =
    | {codexRequest: string, params: unknown}
    | {codexResponse: string}
    | {codexNotification: string}
    | {sessionUpdate: acpV2.SessionUpdate}
    | {promptResponse: unknown}
    | {promptError: unknown}
    | {permissionRequest: acpV2.RequestPermissionRequest}
    | {elicitationRequest: acpV2.CreateElicitationRequest}
    | {elicitationComplete: acpV2.CompleteElicitationNotification};

export type PromptSession = {
    connection: {close(): void};
    transcript: TranscriptEntry[];
    /** Updates published while the session was being set up, before `transcript` starts recording. */
    setupUpdates: acpV2.SessionUpdate[];
    turnStartParams: Array<Record<string, unknown>>;
    setTurnStart(handler: (params: Record<string, unknown>) => Promise<unknown>): void;
    /** Overrides the canned Codex response for a request method other than `turn/start`. */
    setCodexResponse(method: string, handler: (params: unknown) => Promise<unknown>): void;
    appServer: CodexAppServerClient;
    emit(notification: ServerNotification): void;
    /** `signal`, if given, sends `$/cancel_request` for this specific `session/prompt` on abort. */
    sendPrompt(prompt: acpV2.ContentBlock[], signal?: AbortSignal): Promise<any>;
    /** Sends any other agent-bound request (e.g. `session/set_config_option`) on the same connection. */
    request(method: string, params: unknown, signal?: AbortSignal): Promise<any>;
    /** Sends `session/cancel` (a notification, not a request) for this session. */
    cancel(): Promise<void>;
    /** Resolves when the n-th internal prompt run (including its background turn) has finished. */
    promptRunFinished(index?: number): Promise<void>;
    /**
     * Simulates the app-server calling back for a command/file-change/permissions approval, by
     * invoking the handler `CodexAppServerClient` registered for it (e.g.
     * `CommandExecutionApprovalRequest.method`).
     */
    triggerApproval(method: string, params: unknown): Promise<unknown>;
    /** The `{threadId, turnId}` params of every `turn/interrupt` sent to Codex so far, in order. */
    turnInterruptCalls(): Array<{threadId: string, turnId: string}>;
    /** The agent instance behind the connection, for spying on private methods (e.g. `restartCodexClient`). */
    agent: CodexAcpServer;
};

/** Connects a client (v2 by default) to the agent through the router, over a mocked Codex app-server, and opens a session. */
export async function connectSession(protocolVersion: 1 | 2 = 2, options: {
    mcpServers?: acpV2.McpServer[],
    mcpStartup?: McpStartupResult,
    /** Sent on `initialize` (v2 only). */
    clientCapabilities?: acpV2.ClientCapabilities,
    /** The Codex process exit code the agent sees (`null` = still running). */
    exitCode?: () => number | null,
    /** Answers `session/request_permission` (v2 only). Required by tests that trigger one. */
    onRequestPermission?: (request: acpV2.RequestPermissionRequest, signal: AbortSignal) => acpV2.RequestPermissionResponse | Promise<acpV2.RequestPermissionResponse>,
    /** Answers `elicitation/create` (v2 only). Required by tests that trigger one. */
    onElicitation?: (request: acpV2.CreateElicitationRequest, signal: AbortSignal) => acpV2.CreateElicitationResponse | Promise<acpV2.CreateElicitationResponse>,
    /**
     * Overrides canned Codex responses from the start, unlike `setCodexResponse` (only available
     * once `connectSession` has returned). Needed for responses a fire-and-forget background task
     * (e.g. MCP OAuth re-auth) sends before the caller gets a chance to call `setCodexResponse`.
     */
    codexResponses?: Record<string, (params: unknown) => Promise<unknown>>,
} = {}): Promise<PromptSession> {
    const mocks = createMockConnections();
    const transcript: TranscriptEntry[] = [];
    const turnStartParams: Array<Record<string, unknown>> = [];
    const codexResponseOverrides = new Map<string, (params: unknown) => Promise<unknown>>(
        Object.entries(options.codexResponses ?? {}),
    );
    let turnStart: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
        turn: createTurn("inProgress", `turn-${turnStartParams.length}`),
    });
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params?: any) => {
        // The session title is generated on a separate ephemeral thread; keep it out of the way.
        if (method === "thread/start" && params?.ephemeral) {
            return {thread: {...createThread(), id: titleThreadId, ephemeral: true}};
        }
        if (method === "turn/start" && params?.threadId === titleThreadId) {
            return {turn: createTurn("inProgress", "title-turn")};
        }
        if (method !== "turn/start") {
            const override = codexResponseOverrides.get(method);
            return override ? await override(params) : codexResponse(method);
        }
        turnStartParams.push(params as Record<string, unknown>);
        transcript.push({codexRequest: method, params});
        const response = await turnStart(params as Record<string, unknown>);
        transcript.push({codexResponse: method});
        return response;
    });
    const appServer = new CodexAppServerClient(mocks.mockCodexConnection as any);
    const codexAcpClient = new CodexAcpClient(appServer);
    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue(options.mcpStartup ?? {ready: [], failed: [], cancelled: []});
    let agent: CodexAcpServer | null = null;
    const router = createAcpAgentRouter((connection) => {
        agent = new CodexAcpServer(connection, codexAcpClient, undefined, options.exitCode);
        return agent;
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    let recordUpdates = false;
    const setupUpdates: acpV2.SessionUpdate[] = [];
    const onUpdate = (update: acpV2.SessionUpdate | acp.SessionUpdate) => {
        if (protocolVersion === 2) {
            checkV2SessionUpdate(update as acpV2.SessionUpdate);
        }
        if (recordUpdates) {
            transcript.push({sessionUpdate: update as acpV2.SessionUpdate});
        } else {
            setupUpdates.push(update as acpV2.SessionUpdate);
        }
    };
    const clientStream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);
    let connection: {close(): void};
    let request: (method: string, params: unknown, signal?: AbortSignal) => Promise<any>;
    let notifyCancel: () => Promise<void>;
    if (protocolVersion === 2) {
        const v2Connection = acpV2.client({name: "test-client"})
            .onNotification(acpV2.methods.client.session.update, (ctx) => onUpdate(ctx.params.update))
            .onRequest(acpV2.methods.client.session.requestPermission, async (ctx) => {
                transcript.push({permissionRequest: ctx.params});
                if (!options.onRequestPermission) {
                    throw new Error("Received a permission request with no onRequestPermission handler configured");
                }
                return await options.onRequestPermission(ctx.params, ctx.signal);
            })
            .onRequest(acpV2.methods.client.elicitation.create, async (ctx) => {
                transcript.push({elicitationRequest: ctx.params});
                if (!options.onElicitation) {
                    throw new Error("Received an elicitation request with no onElicitation handler configured");
                }
                return await options.onElicitation(ctx.params, ctx.signal);
            })
            .onNotification(acpV2.methods.client.elicitation.complete, (ctx) => {
                transcript.push({elicitationComplete: ctx.params});
            })
            .connect(clientStream);
        await v2Connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
            ...(options.clientCapabilities ? {capabilities: options.clientCapabilities} : {}),
        });
        await v2Connection.agent.request(acpV2.methods.agent.session.new, {cwd, ...(options.mcpServers ? {mcpServers: options.mcpServers} : {})});
        connection = v2Connection;
        request = (method, params, signal) => v2Connection.agent.request(
            method as typeof acpV2.methods.agent.session.prompt,
            params as acpV2.PromptRequest,
            signal ? {cancellationSignal: signal} : undefined,
        );
        notifyCancel = () => v2Connection.agent.notify(acpV2.methods.agent.session.cancel, {sessionId});
    } else {
        const v1Connection = acp.client({name: "test-client"})
            .onNotification(acp.methods.client.session.update, (ctx) => onUpdate(ctx.params.update))
            .connect(clientStream);
        await v1Connection.agent.request(acp.methods.agent.initialize, {protocolVersion: acp.PROTOCOL_VERSION});
        await v1Connection.agent.request(acp.methods.agent.session.new, {cwd, mcpServers: []});
        connection = v1Connection;
        request = (method, params, signal) => v1Connection.agent.request(
            method as typeof acp.methods.agent.session.prompt,
            params as acp.PromptRequest,
            signal ? {cancellationSignal: signal} : undefined,
        );
        notifyCancel = () => v1Connection.agent.notify(acp.methods.agent.session.cancel, {sessionId});
    }
    const promptSpy = vi.spyOn(agent!, "prompt");
    // Session setup publishes updates of its own; wait for them before recording the prompt.
    await vi.waitFor(() => expect(setupUpdates.map(update => update.sessionUpdate)).toContain("available_commands_update"));
    recordUpdates = true;

    const emit = (notification: ServerNotification) => {
        transcript.push({codexNotification: notification.method});
        mocks.getUnhandledNotificationHandler()!(notification);
    };

    const sendPrompt = (prompt: acpV2.ContentBlock[], signal?: AbortSignal) => {
        const response = request("session/prompt", {sessionId, prompt}, signal).then(
            (result) => {
                transcript.push({promptResponse: result});
                return result;
            },
            (error) => {
                transcript.push({promptError: {code: error.code, message: error.message, data: error.data}});
                throw error;
            },
        );
        response.catch(() => {});
        return response;
    };

    return {
        connection,
        transcript,
        setupUpdates,
        turnStartParams,
        setTurnStart: (handler: typeof turnStart) => {
            turnStart = handler;
        },
        setCodexResponse: (method, handler) => {
            codexResponseOverrides.set(method, handler);
        },
        appServer,
        emit,
        sendPrompt,
        request,
        cancel: () => notifyCancel(),
        promptRunFinished: async (index = 0) => {
            await vi.waitFor(() => expect(promptSpy.mock.results.length).toBeGreaterThan(index));
            await promptSpy.mock.results[index]!.value.catch(() => {});
        },
        triggerApproval: async (method, params) => {
            const handler = mocks.getRequestHandler(method);
            if (!handler) {
                throw new Error(`No handler registered for '${method}'`);
            }
            return await handler(params);
        },
        turnInterruptCalls: () => mocks.mockCodexConnection.sendRequest.mock.calls
            .filter(([method]: [string]) => method === "turn/interrupt")
            .map(([, params]: [string, {threadId: string, turnId: string}]) => params),
        agent: agent!,
    };
}

/**
 * Builds a standalone mocked `CodexAcpClient` (with its own mocked Codex connection), suitable as
 * the replacement `restartCodexClient()` resolves to in a provider-restart test. Spied the same
 * way `connectSession`'s own client is, plus an `emit` to fire notifications as if they came from
 * this replacement's (post-restart) app-server process.
 */
export function createReplacementCodexAcpClient(): {
    codexAcpClient: CodexAcpClient;
    appServer: CodexAppServerClient;
    emit(notification: ServerNotification): void;
    turnStartParams: Array<Record<string, unknown>>;
    /** Overrides the canned `turn/start` response, e.g. to run a prompt through this replacement. */
    setTurnStart(handler: (params: Record<string, unknown>) => Promise<unknown>): void;
} {
    const mocks = createMockConnections();
    const turnStartParams: Array<Record<string, unknown>> = [];
    let turnStart: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
        turn: createTurn("inProgress", `replacement-turn-${turnStartParams.length}`),
    });
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params?: any) => {
        if (method !== "turn/start") {
            return codexResponse(method);
        }
        turnStartParams.push(params as Record<string, unknown>);
        return await turnStart(params as Record<string, unknown>);
    });
    const appServer = new CodexAppServerClient(mocks.mockCodexConnection as any);
    const codexAcpClient = new CodexAcpClient(appServer);
    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    return {
        codexAcpClient,
        appServer,
        emit: (notification) => mocks.getUnhandledNotificationHandler()!(notification),
        turnStartParams,
        setTurnStart: (handler) => {
            turnStart = handler;
        },
    };
}

export function userMessageItem(clientId: string | null, text = "Hello"): ThreadItem {
    return {type: "userMessage", id: "item-user", clientId, content: [{type: "text", text, text_elements: []}]};
}

export function itemStarted(item: ThreadItem, id = turnId): ServerNotification {
    return {method: "item/started", params: {threadId: sessionId, turnId: id, item, startedAtMs: 0}};
}

export function itemCompleted(item: ThreadItem, id = turnId): ServerNotification {
    return {method: "item/completed", params: {threadId: sessionId, turnId: id, item, completedAtMs: 0}};
}

export function agentMessageDelta(delta: string, id = turnId, itemId = "item-1"): ServerNotification {
    return {method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: id, itemId, delta}};
}

export function turnStarted(id = turnId): ServerNotification {
    return {method: "turn/started", params: {threadId: sessionId, turn: createTurn("inProgress", id)}};
}

export function turnCompleted(id = turnId): ServerNotification {
    return {method: "turn/completed", params: {threadId: sessionId, turn: createTurn("completed", id)}};
}

/** Lets queued notifications and wire messages settle. */
export async function settle() {
    await new Promise(resolve => setTimeout(resolve, 20));
}

/** The `state_update`s in the transcript, in wire order. */
export function stateUpdates(transcript: TranscriptEntry[]): Array<{state: string, stopReason?: unknown}> {
    return transcript.flatMap(entry => "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "state_update"
        ? [{...entry.sessionUpdate} as {state: string, stopReason?: unknown}]
        : [])
        .map(({state, stopReason}) => stopReason === undefined ? {state} : {state, stopReason});
}

/** Index of the first transcript entry matching the predicate. */
export function indexOf(transcript: TranscriptEntry[], predicate: (entry: TranscriptEntry) => boolean): number {
    return transcript.findIndex(predicate);
}

export const isState = (state: string) => (entry: TranscriptEntry) =>
    "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "state_update"
    && (entry.sessionUpdate as {state: string}).state === state;

export function turnFinished(status: TurnStatus, id = turnId): ServerNotification {
    return {method: "turn/completed", params: {threadId: sessionId, turn: createTurn(status, id)}};
}

export function dump(value: unknown, messageId?: string): string {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    return messageId ? json.replaceAll(messageId, "<messageId>") : json;
}
