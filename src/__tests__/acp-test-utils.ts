import {CodexAcpClient} from '../CodexAcpClient';
import {type CodexConnectionEvent, CodexAppServerClient} from '../CodexAppServerClient';
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexAcpServer} from "../CodexAcpServer";
import type {AgentSideConnection} from "@agentclientprotocol/sdk";
import type {ServerNotification} from "../app-server";
import type {MessageConnection} from "vscode-jsonrpc/node";
import path from "node:path";
import fs from "node:fs";

export type MethodCallEvent = { method: string; args: any[] };

export function createSmartMock<T extends object>(onCall: (event: MethodCallEvent) => void) {
    return new Proxy({} as T, {
        get(_, prop) {
            return (...args: any[]) => {
                onCall({ method: String(prop), args });
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
    getCodexConnectionDump(ignoredFields: string[]): string,
    clearCodexConnectionDump(): void,

    onAcpConnectionEvent(handler: (event: MethodCallEvent) => void): void,
    getAcpConnectionDump(ignoredFields: string[]): string,
    clearAcpConnectionDump(): void,
}

export interface ConnectionConfig {
    connection: MessageConnection;
    getExitCode: () => number | null;
}

export function createBaseTestFixture(config: ConnectionConfig): TestFixture {
    const acpConnectionEvents: MethodCallEvent[] = [];
    const acpEventHandlers: ((event: MethodCallEvent) => void)[] = [];
    const acpConnection = createSmartMock<AgentSideConnection>((event) => {
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
        getCodexConnectionDump(ignoredFields: string[]): string {
            return createArrayDump(transportEvents, ignoredFields);
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
}

/**
 * Creates a test fixture with a mock Codex connection.
 * Use for unit tests that don't need a real Codex binary.
 * Provides `sendServerNotification()` to simulate server notifications.
 */
export function createCodexMockTestFixture(): CodexMockTestFixture {
    let unhandledNotificationHandler: ((notification: any) => void) | null = null;

    const mockCodexConnection = {
        sendRequest: () => Promise.resolve(undefined),
        onUnhandledNotification: (handler: (notification: any) => void) => {
            unhandledNotificationHandler = handler;
        },
        onNotification: () => {},
        end: () => {},
    } as unknown as MessageConnection;

    const baseFixture = createBaseTestFixture({
        connection: mockCodexConnection,
        getExitCode: () => null
    });

    return {
        ...baseFixture,
        sendServerNotification(notification: ServerNotification): void {
            if (unhandledNotificationHandler) {
                unhandledNotificationHandler(notification);
            }
        }
    };
}

export function createObjectDump(obj: any, anonymizedFields: string[] = []) {
    function fieldAnonymizer(key: string, value: any): any {
        return anonymizedFields.includes(key) ? key : value;
    }
    return JSON.stringify(obj, fieldAnonymizer, 2);
}

export function createArrayDump(objects: any[], anonymizedFields: string[]): string {
    return objects.map(event => createObjectDump(event, anonymizedFields)).join("\n");
}