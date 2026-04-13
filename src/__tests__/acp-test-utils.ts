import {CodexAcpClient} from '../CodexAcpClient';
import {type CodexConnectionEvent, CodexAppServerClient} from '../CodexAppServerClient';
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexAcpServer, type SessionState} from "../CodexAcpServer";
import type {AgentSideConnection, RequestPermissionResponse} from "@agentclientprotocol/sdk";
import type {ServerNotification} from "../app-server";
import type {MessageConnection} from "vscode-jsonrpc/node";
import path from "node:path";
import fs from "node:fs";
import {AgentMode} from "../AgentMode";
import {expect, vi} from "vitest";

export type MethodCallEvent = { method: string; args: any[] };

export interface SmartMockConfig {
    returnValues?: Map<string, () => any>;
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
                    return returnValueFn();
                }
                return { mock: "Mocked return" };
            };
        }
    });
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
    connection: AgentSideConnection;
    events: MethodCallEvent[];
    eventHandlers: ((event: MethodCallEvent) => void)[];
}

export interface ConnectionConfig {
    connection: MessageConnection;
    getExitCode: () => number | null;
    acpConnection?: AcpConnectionConfig;
}

export function createBaseTestFixture(config: ConnectionConfig): TestFixture {
    const acpConnectionEvents = config.acpConnection?.events ?? [];
    const acpEventHandlers = config.acpConnection?.eventHandlers ?? [];
    const acpConnection = config.acpConnection?.connection ?? createSmartMock<AgentSideConnection>((event) => {
        acpConnectionEvents.push(event);
        acpEventHandlers.forEach(handler => handler(event));
    });

    const codexAppServerClient = new CodexAppServerClient(config.connection);
    const codexAcpClient = new CodexAcpClient(codexAppServerClient);
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

    const codexConnection = startCodexConnection(pathToCodex);

    return createBaseTestFixture({
        connection: codexConnection.connection,
        getExitCode: () => codexConnection.process.exitCode
    });
}

export interface CodexMockTestFixture extends TestFixture {
    sendServerNotification(notification: ServerNotification | Record<string, unknown>): void,
    sendServerRequest<T>(method: string, params: unknown): Promise<T>,
    setPermissionResponse(response: RequestPermissionResponse): void,
}

/**
 * Creates a test fixture with a mock Codex connection.
 * Use for unit tests that don't need a real Codex binary.
 * Provides `sendServerNotification()` to simulate server notifications.
 * Provides `sendServerRequest()` to simulate server-initiated requests (e.g., approval requests).
 * Provides `setPermissionResponse()` to control ACP permission dialog responses.
 */
export function createCodexMockTestFixture(): CodexMockTestFixture {
    let unhandledNotificationHandler: ((notification: any) => void) | null = null;
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

    // State for controlling permission responses
    const permissionState: { response: RequestPermissionResponse } = {
        response: { outcome: { outcome: 'cancelled' } }
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
    const returnValues = new Map<string, () => any>();
    returnValues.set('requestPermission', () => permissionState.response);

    const acpConnection = createSmartMock<AgentSideConnection>((event) => {
        acpConnectionEvents.push(event);
        acpEventHandlers.forEach(handler => handler(event));
    }, { returnValues });

    const baseFixture = createBaseTestFixture({
        connection: mockCodexConnection,
        getExitCode: () => null,
        acpConnection: {
            connection: acpConnection,
            events: acpConnectionEvents,
            eventHandlers: acpEventHandlers,
        }
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
        cwd: "/test/cwd",
        sessionId: "session-id",
        currentModelId: "model-id[effort]",
        supportedReasoningEfforts: [],
        supportedInputModalities: ["text", "image"],
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
        ...overrides,
    };
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

    await vi.waitFor(() => {
        const dump = fixture.getAcpConnectionDump([]);
        expect(dump.length).toBeGreaterThan(0);
    });
}
