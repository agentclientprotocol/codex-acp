import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAcpServer } from '../../CodexAcpServer';
import * as acp from '@agentclientprotocol/sdk';
import { createMockConnections } from './test-utils';
import {getCodexAuthMethods} from "../../CodexAuthMethod";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import packageJson from "../../../package.json";

describe('CodexACPAgent - initialize', () => {
    let agent: CodexAcpServer;
    let mockAcpConnection: any;
    let mockCodexConnection: any;

    beforeEach(() => {
        const mocks = createMockConnections();
        mockAcpConnection = mocks.mockAcpConnection;
        mockCodexConnection = mocks.mockCodexConnection;
        const codexAppServerClient = new CodexAppServerClient(mockCodexConnection);
        const codexAcpClient = new CodexAcpClient(codexAppServerClient);
        agent = new CodexAcpServer(mockAcpConnection, codexAcpClient);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should return protocol version and agent capabilities', async () => {
        const params: acp.InitializeRequest = {
            protocolVersion: acp.PROTOCOL_VERSION
        };
        const result = await agent.initialize(params);
        expect(result).toEqual({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            agentCapabilities: {
                auth: {
                    logout: {},
                },
                loadSession: true,
                promptCapabilities: {
                    embeddedContext: true,
                    image: true
                },
                sessionCapabilities: {
                    resume: {},
                    list: {},
                    close: {},
                    delete: {},
                    additionalDirectories: {},
                },
                mcpCapabilities: {
                    acp: false,
                    http: true,
                    sse: false,
                },
            },
            authMethods: getCodexAuthMethods(),
        });
    });

    it('should advertise gateway auth when the client opts into gateway auth metadata', async () => {
        const params: acp.InitializeRequest = {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                auth: {
                    _meta: {
                        gateway: true,
                    }
                }
            }
        };

        const result = await agent.initialize(params);

        expect(result.authMethods).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "gateway",
            })
        ]));
    });
});
