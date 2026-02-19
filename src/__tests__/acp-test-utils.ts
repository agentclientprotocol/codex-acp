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
    getCodexConnectionDump(ignoredFields: string[], options?: { ignoreNotificationMethods?: string[] }): string,
    clearCodexConnectionDump(): void,

    onAcpConnectionEvent(handler: (event: MethodCallEvent) => void): void,
    getAcpConnectionDump(ignoredFields: string[]): string,
    clearAcpConnectionDump(): void,
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
        getCodexConnectionDump(ignoredFields: string[], options?: { ignoreNotificationMethods?: string[] }): string {
            const ignoredMethods = new Set(options?.ignoreNotificationMethods ?? []);
            const filteredEvents = ignoredMethods.size === 0
                ? transportEvents
                : transportEvents.filter((event) =>
                    !(event.eventType === "notification" && ignoredMethods.has(event.method))
                );
            return createArrayDump(filteredEvents, ignoredFields);
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
        getAcpConnectionDump(ignoredFields: string[]): string {
            return createArrayDump(acpConnectionEvents, ignoredFields);
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
    sendServerNotification(notification: ServerNotification): void,
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
        sendServerNotification(notification: ServerNotification): void {
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
    const fieldsToAnonymize = new Set(anonymizedFields);

    function anonymizeValue(value: any, path: string[]): any {
        if (value === null || typeof value !== "object") {
            return value;
        }

        if (Array.isArray(value)) {
            return value.map((item, index) => anonymizeValue(item, [...path, String(index)]));
        }

        return Object.fromEntries(
            Object.entries(value).map(([key, val]) => {
                const nextPath = [...path, key];
                const pathKey = nextPath.join(".");
                if (fieldsToAnonymize.has(key) || fieldsToAnonymize.has(pathKey)) {
                    return [key, key];
                }
                return [key, anonymizeValue(val, nextPath)];
            })
        );
    }

    return JSON.stringify(anonymizeValue(obj, []), null, 2);
}

export function createArrayDump(objects: any[], anonymizedFields: string[]): string {
    return objects.map(event => createObjectDump(event, anonymizedFields)).join("\n");
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
