import {CodexAcpClient} from '../CodexAcpClient';
import {type CodexConnectionEvent, CodexAppServerClient} from '../CodexAppServerClient';
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexAcpServer} from "../CodexAcpServer";
import type {AgentSideConnection} from "@agentclientprotocol/sdk";
import path from "node:path";

export type MethodCallEvent = { method: string; args: any[] };

function createSmartMock<T extends object>(onCall: (event: MethodCallEvent) => void) {
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

export function createTestFixture(): TestFixture {
    const pathToCodex = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === 'win32' ? "codex.cmd" : "codex");
    const acpConnectionEvents: MethodCallEvent[] = []
    const acpEventHandlers: ((event: MethodCallEvent) => void)[] = [];
    const acpConnection = createSmartMock<AgentSideConnection>((event) => {
        acpConnectionEvents.push(event);
        acpEventHandlers.forEach(handler => handler(event));
    });
    const codexConnection = startCodexConnection(pathToCodex);
    const codexAppServerClient = new CodexAppServerClient(codexConnection.connection);

    const codexAcpClient = new CodexAcpClient(codexAppServerClient);
    const codexAcpAgent = new CodexAcpServer(acpConnection, codexAcpClient, undefined, () => codexConnection.process.exitCode);

    const transportEvents: CodexConnectionEvent[] = []
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
        clearAcpConnectionDump(){
            acpConnectionEvents.splice(0, acpConnectionEvents.length);
        }
    };
}


function createObjectDump(obj: any, anonymizedFields: string[] = []) {
    function fieldAnonymizer(key: string, value: any): any {
        return anonymizedFields.includes(key) ? key : value;
    }
    return JSON.stringify(obj, fieldAnonymizer, 2);
}

function createArrayDump(objects: any[], anonymizedFields: string[]): string {
    return objects.map(event => createObjectDump(event, anonymizedFields)).join("\n");
}