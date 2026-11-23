import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAcpServer } from '../../CodexAcpServer';
import * as acp from '@agentclientprotocol/sdk/unstable';
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
                    status: {},
                },
                providers: {},
                loadSession: true,
                promptCapabilities: {
                    embeddedContext: true,
                    image: true
                },
                sessionCapabilities: {
                    options: {},
                    resume: {},
                    list: {},
                    close: {},
                    delete: {},
                    fork: {},
                    title: {},
                    additionalDirectories: {},
                    systemPrompt: {},
                },
                mcpCapabilities: {
                    acp: false,
                    http: true,
                    sse: false,
                },
                _meta: {
                    authStatus: {},
                },
            },
            authMethods: getCodexAuthMethods(),
            _meta: {
                steering: {
                    supported: true,
                },
            },
        });
    });

    it.each([1, 2] as const)("omits the options capability for JetBrains 2026.1 on v%s", async version => {
        const info = {name: "JetBrains.WebStorm", version: "2026.1.1"};
        const session = version === 1
            ? (await agent.initialize({protocolVersion: 1, clientInfo: info})).agentCapabilities?.sessionCapabilities
            : (await agent.initializeV2({protocolVersion: 2, info})).capabilities?.session;
        expect(session).not.toHaveProperty("options");
    });

    it('should advertise the AIR extension only to AIR', async () => {
        const result = await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: []}}}},
        });
        expect(result._meta).toEqual({
            steering: {
                supported: true,
            },
            jetbrains: {
                air: {
                    version: 1,
                    goal: {
                        version: 1,
                        controlMethod: "_session/goal",
                        actions: ["set", "pause", "resume", "clear"],
                    },
                    capabilities: ["sessionFailure", "diffPatch", "agentFileChangeReport", "customInstructions", "nativeSubagentSessions", "asyncTasks", "recommendedValue", "rawInputRendering", "planContentDelta", "codexHooks"],
                },
            },
        });
    });

    it.each([
        ["a standard client", {subagents: {}}, undefined],
        ["AIR", {subagents: {}, _meta: {jetbrains: {air: {version: 1, capabilities: []}}}}, {}],
    ])('answers %s with the subagent session capability that only the AIR contract negotiates', async (_name, clientCapabilities, expected) => {
        const result = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities});
        expect((result.agentCapabilities?.sessionCapabilities as {subagents?: unknown}).subagents).toEqual(expected);
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

    it('enables experimental thread settings without requesting attestation', async () => {
        await agent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                elicitation: { form: {}, url: {} },
            },
        });

        expect(mockCodexConnection.sendRequest).toHaveBeenCalledWith("initialize", expect.objectContaining({
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
            },
        }));
    });

    it('should advertise API key auth with the legacy metadata method', () => {
        expect(getCodexAuthMethods()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "api-key",
                _meta: {
                    "api-key": {
                        provider: "openai",
                    },
                },
            }),
        ]));
        expect(getCodexAuthMethods()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({type: "env_var"}),
            expect.objectContaining({id: "codex-api-key"}),
            expect.objectContaining({id: "openai-api-key"}),
        ]));
    });

    it('should advertise ChatGPT device code auth only when the client supports URL elicitation', () => {
        const withUrlElicitation = getCodexAuthMethods({elicitation: {url: {}}})
            .map((method) => method.id);
        expect(withUrlElicitation).toContain("chat-gpt-device-code");

        const withoutUrlElicitation = getCodexAuthMethods({elicitation: {form: {}}})
            .map((method) => method.id);
        expect(withoutUrlElicitation).not.toContain("chat-gpt-device-code");
    });

    it('should not advertise ChatGPT auth when browser auth is disabled', () => {
        const methodIds = getCodexAuthMethods(undefined, {NO_BROWSER: "1"} as NodeJS.ProcessEnv)
            .map((method) => method.id);

        expect(methodIds).not.toContain("chat-gpt");
        expect(methodIds).toEqual(expect.arrayContaining(["api-key"]));
    });
});
