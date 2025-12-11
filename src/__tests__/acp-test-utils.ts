import {CodexAcpClient} from '../CodexAcpClient';
import {type ClientTransportEvent, CodexAppServerClient} from '../CodexAppServerClient';
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexACPAgent} from "../CodexACPAgent";

export interface TestFixture {
    getCodexAppServerClient(): CodexAppServerClient,
    getCodexAcpClient(): CodexAcpClient,
    getCodexAcpAgent(): CodexACPAgent,
    getTransportEvents(): ClientTransportEvent[],
    getTransportDump(ignoredFields: string[]): string,
    clearTransportDump(): void
}

export function createTestFixture(): TestFixture {
    const pathToCodex = "././node_modules/.bin/codex"
    const mockedAcpConnection = { } as any;
    const codexAppServerClient = new CodexAppServerClient(startCodexConnection(pathToCodex));

    const codexAcpClient = new CodexAcpClient(codexAppServerClient);
    const codexAcpAgent = new CodexACPAgent(mockedAcpConnection, codexAcpClient);

    const transportEvents: ClientTransportEvent[] = []
    codexAppServerClient.onClientTransportEvent((event) => {
        transportEvents.push(event);
    });

    return {
        getCodexAcpAgent(): CodexACPAgent {
            return codexAcpAgent;
        },
        getCodexAcpClient(): CodexAcpClient {
            return codexAcpClient;
        },
        getTransportDump(ignoredFields: string[]): string {
            function stringify(obj: any, anonymizedFields: string[] = []) {
                function fieldAnonymizer(key: string, value: any): any {
                    return anonymizedFields.includes(key) ? key : value;
                }
                return JSON.stringify(obj, fieldAnonymizer, 2);
            }
            return this.getTransportEvents().map(event => stringify(event, ignoredFields)).join("\n");
        },
        getTransportEvents(): ClientTransportEvent[] {
            return transportEvents;
        },
        getCodexAppServerClient(): CodexAppServerClient {
            return codexAppServerClient;
        },
        clearTransportDump(): void {
            transportEvents.splice(0, transportEvents.length);
        }
    };
}