import * as acp from "@agentclientprotocol/sdk";
import type {CreateElicitationResponse, McpServerStdio, RequestPermissionResponse} from "@agentclientprotocol/sdk";
import {CodexAcpClient, type JsonObject} from '../CodexAcpClient';
import {CodexAppServerClient, type CodexConnectionEvent} from '../CodexAppServerClient';
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexAcpServer, type SessionState} from "../CodexAcpServer";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ServerNotification} from "../app-server";
import type {MessageConnection} from "vscode-jsonrpc/node";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {AgentMode} from "../AgentMode";
import {DEFAULT_COLLABORATION_MODE} from "../CollaborationModeConfig";
import {expect, vi} from "vitest";
import type {Model, ReasoningEffortOption} from "../app-server/v2";

export type MethodCallEvent = { method: string; args: any[] };

export interface SmartMockConfig {
    returnValues?: Map<string, (args: any[]) => any>;
}

export function createSmartMock<T extends object>(
    onCall: (event: MethodCallEvent) => void,
    config?: SmartMockConfig
) {
    return new Proxy({} as T, {
        get(_, prop) {
            return (...args: any[]) => {
                onCall({ method: String(prop), args });
                const returnValueFn = config?.returnValues?.get(String(prop));
                if (returnValueFn) {
                    return returnValueFn(args);
                }
                return { mock: "Mocked return" };
            };
        }
    });
}

function normalizeAcpConnectionEvent(event: MethodCallEvent): MethodCallEvent {
    if (event.method === "request" && event.args[0] === acp.methods.client.session.requestPermission) {
        return {method: "requestPermission", args: [event.args[1]]};
    }
    if (event.method === "request" && event.args[0] === acp.methods.client.elicitation.create) {
        return {method: "createElicitation", args: [event.args[1]]};
    }
    if (event.method === "notify" && event.args[0] === acp.methods.client.elicitation.complete) {
        return {method: "completeElicitation", args: [event.args[1]]};
    }
    if (event.method === "notify" && event.args[0] === acp.methods.client.session.update) {
        return {method: "sessionUpdate", args: [event.args[1]]};
    }
    return event;
}

export interface TestFixture {
    getCodexAppServerClient(): CodexAppServerClient,
    getCodexAcpClient(): CodexAcpClient,
    getCodexAcpAgent(): CodexAcpServer,

    onCodexConnectionEvent(handler: (event: CodexConnectionEvent) => void): void,
    getCodexConnectionEvents(ignoredFields: string[], options?: CodexConnectionDumpOptions): CodexConnectionEvent[],
    getCodexConnectionDump(ignoredFields: string[], options?: CodexConnectionDumpOptions): string,
    clearCodexConnectionDump(): void,

    onAcpConnectionEvent(handler: (event: MethodCallEvent) => void): void,
    getAcpConnectionEvents(ignoredFields: string[]): MethodCallEvent[],
    getAcpConnectionDump(ignoredFields: string[]): string,
    clearAcpConnectionDump(): void,
}

export interface CodexConnectionDumpOptions {
    placeholderResponseMethods?: string[];
}

export interface AcpConnectionConfig {
    connection: AcpClientConnection;
    events: MethodCallEvent[];
    eventHandlers: ((event: MethodCallEvent) => void)[];
}

export interface ConnectionConfig {
    connection: MessageConnection;
    getExitCode: () => number | null;
    acpConnection?: AcpConnectionConfig;
    codexConfig?: JsonObject;
}

export function createBaseTestFixture(config: ConnectionConfig): TestFixture {
    const acpConnectionEvents = config.acpConnection?.events ?? [];
    const acpEventHandlers = config.acpConnection?.eventHandlers ?? [];
    const acpConnection = config.acpConnection?.connection ?? createSmartMock<AcpClientConnection>((event) => {
        const normalizedEvent = normalizeAcpConnectionEvent(event);
        acpConnectionEvents.push(normalizedEvent);
        acpEventHandlers.forEach(handler => handler(normalizedEvent));
    });

    const codexAppServerClient = new CodexAppServerClient(config.connection);
    const codexAcpClient = new CodexAcpClient(codexAppServerClient, config.codexConfig);
    const codexAcpAgent = new CodexAcpServer(acpConnection, codexAcpClient, undefined, config.getExitCode);

    const transportEvents: CodexConnectionEvent[] = [];
    const codexEventHandlers: ((event: CodexConnectionEvent) => void)[] = [];
    codexAppServerClient.onClientTransportEvent((event) => {
        transportEvents.push(event);
        codexEventHandlers.forEach(handler => handler(event));
    });

    return {
        getCodexAcpAgent(): CodexAcpServer {
            return codexAcpAgent;
        },
        getCodexAcpClient(): CodexAcpClient {
            return codexAcpClient;
        },
        getCodexConnectionEvents(ignoredFields: string[], options?: CodexConnectionDumpOptions): CodexConnectionEvent[] {
            const placeholderResponseMethods = new Set(options?.placeholderResponseMethods ?? []);
            const pendingRequestMethods: string[] = [];

            return transportEvents.flatMap((event) => {
                switch (event.eventType) {
                    case "request":
                        pendingRequestMethods.push(event.method);
                        break;
                    case "response":
                        const requestMethod = pendingRequestMethods.shift();
                        if (requestMethod && placeholderResponseMethods.has(requestMethod)) {
                            return [{
                                eventType: "response" as const,
                                placeholder: requestMethod,
                            } as CodexConnectionEvent];
                        }
                        break;
                }

                return [anonymizeValue(event, [], new Set(ignoredFields)) as CodexConnectionEvent];
            });
        },
        getCodexConnectionDump(ignoredFields: string[], options?: CodexConnectionDumpOptions): string {
            const filteredEvents = this.getCodexConnectionEvents(ignoredFields, options);
            return createArrayDump(filteredEvents, []);
        },
        onCodexConnectionEvent(handler: (event: CodexConnectionEvent) => void): void {
            codexEventHandlers.push(handler);
        },
        getCodexAppServerClient(): CodexAppServerClient {
            return codexAppServerClient;
        },
        clearCodexConnectionDump(): void {
            transportEvents.splice(0, transportEvents.length);
        },
        onAcpConnectionEvent(handler: (event: MethodCallEvent) => void): void {
            acpEventHandlers.push(handler);
        },
        getAcpConnectionEvents(ignoredFields: string[]): MethodCallEvent[] {
            return acpConnectionEvents.map(event => anonymizeValue(event, [], new Set(ignoredFields)) as MethodCallEvent);
        },
        getAcpConnectionDump(ignoredFields: string[]): string {
            return createArrayDump(this.getAcpConnectionEvents(ignoredFields), []);
        },
        clearAcpConnectionDump() {
            acpConnectionEvents.splice(0, acpConnectionEvents.length);
        }
    };
}

/**
 * Creates a test fixture with a real Codex connection.
 * Use for integration tests that need to interact with the actual Codex binary.
 */
export function createTestFixture(): TestFixture {
    const pathToCodex = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === 'win32' ? "codex.cmd" : "codex");
    if (!fs.existsSync(pathToCodex)) {
        throw new Error(`Codex binary not found at ${pathToCodex}. Did you run 'npm install'?`);
    }

    const codexHome = createTestCodexHome();
    const codexConnection = startCodexConnection(pathToCodex, {
        ...process.env,
        CODEX_HOME: codexHome,
    });
    codexConnection.process.on("exit", () => {
        removeDirectoryWithRetry(codexHome);
    });

    return createBaseTestFixture({
        connection: codexConnection.connection,
        getExitCode: () => codexConnection.process.exitCode
    });
}

function createTestCodexHome(): string {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-codex-home-"));
    writeCodexHomeConfig(codexHome);
    return codexHome;
}

export function writeCodexHomeConfig(
    codexHome: string,
    extras: Record<string, string> = {},
    mcpServers: McpServerStdio[] = [],
): void {
    const entries: Record<string, string> = {
        cli_auth_credentials_store: "file",
        ...extras,
    };
    let body = Object.entries(entries)
        .map(([key, value]) => `${key} = "${value}"`)
        .join("\n");
    for (const server of mcpServers) {
        body += `\n\n[mcp_servers."${escapeTOML(server.name)}"]`;
        body += `\ncommand = "${escapeTOML(server.command)}"`;
        const argsToml = server.args.map(a => `"${escapeTOML(a)}"`).join(", ");
        body += `\nargs = [${argsToml}]`;
        if (server.env && server.env.length > 0) {
            const envPairs = server.env
                .map(e => `${e.name} = "${escapeTOML(e.value)}"`)
                .join(", ");
            body += `\nenv = {${envPairs}}`;
        }
    }
    fs.writeFileSync(path.join(codexHome, "config.toml"), body, "utf8");
}

function escapeTOML(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function removeDirectoryWithRetry(directory: string): void {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            fs.rmSync(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== "ENOTEMPTY" && err.code !== "EBUSY") {
                return;
            }
        }
    }
}

export interface CodexMockTestFixture extends TestFixture {
    sendServerNotification(notification: ServerNotification | Record<string, unknown>): void,
    sendServerRequest<T>(method: string, params: unknown): Promise<T>,
    setPermissionResponse(response: RequestPermissionResponse): void,
    setElicitationResponse(response: CreateElicitationResponse | Promise<CreateElicitationResponse>): void,
}

/**
 * Creates a test fixture with a mock Codex connection.
 * Use for unit tests that don't need a real Codex binary.
 * Provides `sendServerNotification()` to simulate server notifications.
 * Provides `sendServerRequest()` to simulate server-initiated requests (e.g., approval requests).
 * Provides `setPermissionResponse()` to control ACP permission dialog responses.
 */
export function createCodexMockTestFixture(options?: { codexConfig?: JsonObject }): CodexMockTestFixture {
    let unhandledNotificationHandler: ((notification: any) => void) | null = null;
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

    // State for controlling permission responses
    const permissionState: { response: RequestPermissionResponse } = {
        response: { outcome: { outcome: 'cancelled' } }
    };
    const elicitationState: { response: CreateElicitationResponse | Promise<CreateElicitationResponse> } = {
        response: { action: 'cancel' }
    };

    const mockCodexConnection = {
        sendRequest: () => Promise.resolve(undefined),
        onUnhandledNotification: (handler: (notification: any) => void) => {
            unhandledNotificationHandler = handler;
        },
        onNotification: () => {},
        onRequest: (type: { method: string }, handler: (params: unknown) => Promise<unknown>) => {
            requestHandlers.set(type.method, handler);
        },
        end: () => {},
    } as unknown as MessageConnection;

    // Create ACP connection with configurable permission response
    const acpConnectionEvents: MethodCallEvent[] = [];
    const acpEventHandlers: ((event: MethodCallEvent) => void)[] = [];
    const returnValues = new Map<string, (args: any[]) => any>();
    returnValues.set('request', (args) => {
        if (args[0] === acp.methods.client.session.requestPermission) {
            return permissionState.response;
        }
        if (args[0] === acp.methods.client.elicitation.create) {
            return elicitationState.response;
        }
        return { mock: "Mocked return" };
    });
    returnValues.set('requestPermission', () => permissionState.response);

    const acpConnection = createSmartMock<AcpClientConnection>((event) => {
        const normalizedEvent = normalizeAcpConnectionEvent(event);
        acpConnectionEvents.push(normalizedEvent);
        acpEventHandlers.forEach(handler => handler(normalizedEvent));
    }, { returnValues });

    const baseFixture = createBaseTestFixture({
        connection: mockCodexConnection,
        getExitCode: () => null,
        acpConnection: {
            connection: acpConnection,
            events: acpConnectionEvents,
            eventHandlers: acpEventHandlers,
        },
        ...(options?.codexConfig != null ? { codexConfig: options.codexConfig } : {}),
    });

    return {
        ...baseFixture,
        sendServerNotification(notification: ServerNotification | Record<string, unknown>): void {
            if (unhandledNotificationHandler) {
                unhandledNotificationHandler(notification);
            }
        },
        async sendServerRequest<T>(method: string, params: unknown): Promise<T> {
            const handler = requestHandlers.get(method);
            if (!handler) {
                throw new Error(`No handler registered for ${method}`);
            }
            return await handler(params) as T;
        },
        setPermissionResponse(response: RequestPermissionResponse): void {
            permissionState.response = response;
        },
        setElicitationResponse(response: CreateElicitationResponse | Promise<CreateElicitationResponse>): void {
            elicitationState.response = response;
        },
    };
}

export function createObjectDump(obj: any, anonymizedFields: string[] = []) {
    return JSON.stringify(anonymizeValue(obj, [], new Set(anonymizedFields)), null, 2);
}

export function createArrayDump(objects: any[], anonymizedFields: string[]): string {
    return objects.map(event => createObjectDump(event, anonymizedFields)).join("\n");
}

function anonymizeValue(value: any, path: string[], fieldsToAnonymize: Set<string>): any {
    if (value === null || typeof value !== "object") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => anonymizeValue(item, [...path, String(index)], fieldsToAnonymize));
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, val]) => {
            const nextPath = [...path, key];
            const pathKey = nextPath.join(".");
            if (fieldsToAnonymize.has(key) || fieldsToAnonymize.has(pathKey)) {
                return [key, key];
            }
            return [key, anonymizeValue(val, nextPath, fieldsToAnonymize)];
        })
    );
}

/**
 * Creates a default SessionState for use in tests.
 * Override specific fields as needed.
 */
export function createTestSessionState(overrides?: Partial<SessionState>): SessionState {
    return {
        currentTurnId: null,
        lastTokenUsage: null,
        totalTokenUsage: null,
        modelContextWindow: null,
        rateLimits: null,
        account: null,
        authConfigured: overrides?.account !== undefined ? overrides.account !== null : false,
        authProvider: null,
        cwd: "/test/cwd",
        additionalDirectories: [],
        sessionId: "session-id",
        currentModelId: "model-id[effort]",
        availableModels: [],
        supportedReasoningEfforts: [],
        supportedInputModalities: ["text", "image"],
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
        collaborationMode: DEFAULT_COLLABORATION_MODE,
        fastModeEnabled: false,
        currentModelSupportsFast: false,
        terminalOutputMode: "terminal_output_delta",
        goalRevision: 0,
        sessionTitle: null,
        sessionTitleSource: "unknown",
        ...overrides,
    };
}

export function createTestModel(overrides?: Partial<Model>): Model {
    const id = overrides?.id ?? "model-id";
    const defaultEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Balanced"};
    return {
        id,
        model: id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: id,
        description: `${id} model`,
        hidden: false,
        supportedReasoningEfforts: [defaultEffort],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        ...overrides,
    };
}

export function setupPromptTestSession(sessionOverrides?: Partial<SessionState>) {
    const mockFixture = createCodexMockTestFixture();
    const sessionState = createTestSessionState(sessionOverrides);

    vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    const turnStartSpy = mockPromptTurn(mockFixture, sessionState.sessionId);

    return {mockFixture, sessionState, turnStartSpy};
}

export function mockPromptTurn(fixture: CodexMockTestFixture, sessionId: string) {
    const codexAppServerClient = fixture.getCodexAppServerClient();
    const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
        turn: {
            id: "turn-id",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        }
    });
    vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
        threadId: sessionId,
        turn: {
            id: "turn-id",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        }
    });

    return turnStartSpy;
}

export async function setupPromptAndSendNotifications(
    fixture: CodexMockTestFixture,
    sessionId: string,
    sessionState: SessionState,
    notifications: ServerNotification[]
): Promise<void> {
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAppServerClient = fixture.getCodexAppServerClient();
    const turn = { id: "turn-id", items: [], status: "inProgress" as const, error: null };

    codexAppServerClient.turnStart = vi.fn().mockResolvedValue({
        turn,
    });
    codexAppServerClient.awaitTurnCompleted = vi.fn().mockResolvedValue({
        threadId: sessionId,
        turn: { ...turn, status: "completed" },
    });

    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

    await codexAcpAgent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test prompt" }],
    });

    fixture.clearAcpConnectionDump();

    for (const notification of notifications) {
        fixture.sendServerNotification(notification);
    }
    await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

    await vi.waitFor(() => {
        const dump = fixture.getAcpConnectionDump([]);
        expect(dump.length).toBeGreaterThan(0);
    });
}
