// noinspection ES6RedundantAwait

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR, type CodexAuthRequest} from "../../CodexAuthMethod";
import type * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestFixture,
    createTestModel,
    createTestSessionState,
    type TestFixture
} from "../acp-test-utils";
import type {ServerNotification} from "../../app-server";
import type {SessionState} from "../../CodexAcpServer";
import {AgentMode} from "../../AgentMode";
import type {Model, ReviewStartResponse, ThreadGoal, TurnCompletedNotification, TurnStartParams} from "../../app-server/v2";
import type {RateLimitsMap} from "../../RateLimitsMap";
import {ModelId} from "../../ModelId";

describe('ACP server test', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const ignoredFields = ["thread", "cwd", "id", "createdAt", "path", "threadId", "userAgent", "sandbox",  "conversationId", "origins", "supportedReasoningEfforts", "reasoningEffort", "model", "readOnlyAccess", "approvalsReviewer"];

    it('should throw error without authentication', async () => {
        const authFixture = createTestFixture();
        const codexAcpAgent = authFixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await authFixture.getCodexAcpClient().logout();
        authFixture.clearCodexConnectionDump();

        await expect(
            codexAcpAgent.newSession({cwd: "", mcpServers: []})
        ).rejects.toThrow("Authentication required");

        const transportDump = authFixture.getCodexConnectionDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/auth-failed.json");
    });

    it('should authenticate with key', async () => {
        const keyFixture = createTestFixture();
        const codexAcpAgent = keyFixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await keyFixture.getCodexAcpClient().logout();


        const unauthenticatedResponse = await keyFixture.getCodexAcpAgent().extMethod("authentication/status", {});
        expect(unauthenticatedResponse).toEqual({type: "unauthenticated"});

        keyFixture.clearCodexConnectionDump();

        const authRequest: CodexAuthRequest = { methodId: "api-key", _meta: { "api-key": { apiKey: "TOKEN" }}};
        await codexAcpAgent.authenticate(authRequest);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        expect(newSessionResponse.sessionId).toBeDefined();

        const transportEvents = keyFixture.getCodexConnectionEvents([...ignoredFields, "upgrade"]);
        const transportMethods = transportEvents.flatMap(event => "method" in event ? [event.method] : []);
        const loginRequest = transportEvents.find(event =>
            event.eventType === "request" &&
            "method" in event &&
            event.method === "account/login/start"
        );
        const loginResponse = transportEvents.find(event =>
            event.eventType === "response" &&
            "type" in event &&
            event.type === "apiKey"
        );
        const threadStartResponse = transportEvents.find(event =>
            event.eventType === "response" &&
            "modelProvider" in event &&
            "approvalPolicy" in event
        );
        expect(transportMethods).toEqual([
            "account/login/start",
            "account/read",
            "account/updated",
            "thread/start",
            "model/list",
            "thread/started",
            "account/read",
            "skills/list",
        ]);
        expect(loginRequest).toEqual({
            eventType: "request",
            method: "account/login/start",
            params: {
                type: "apiKey",
                apiKey: "TOKEN",
            }
        });
        expect(loginResponse).toEqual({
            eventType: "response",
            type: "apiKey",
        });
        expect(threadStartResponse).toMatchObject({
            eventType: "response",
            modelProvider: "openai",
            approvalPolicy: "on-request",
            approvalsReviewer: "approvalsReviewer",
        });
        const authenticatedResponse = await keyFixture.getCodexAcpAgent().extMethod("authentication/status", {});
        expect(authenticatedResponse).toEqual({type: "api-key"});

        await keyFixture.getCodexAcpAgent().logout({});
        const logoutResponse = await keyFixture.getCodexAcpAgent().extMethod("authentication/status", {});
        expect(logoutResponse).toEqual({type: "unauthenticated"});
    });

    it('should authenticate with CODEX_API_KEY from the environment', async () => {
        const envFixture = createTestFixture();
        const codexAcpAgent = envFixture.getCodexAcpAgent();
        vi.stubEnv(CODEX_API_KEY_ENV_VAR, "CODEX_ENV_TOKEN");
        vi.stubEnv(OPENAI_API_KEY_ENV_VAR, "OPENAI_ENV_TOKEN");

        await codexAcpAgent.initialize({protocolVersion: 1});
        await envFixture.getCodexAcpClient().logout();
        envFixture.clearCodexConnectionDump();

        await codexAcpAgent.authenticate({methodId: "api-key"});

        const transportEvents = envFixture.getCodexConnectionEvents([]);
        const loginRequest = transportEvents.find(event =>
            event.eventType === "request" &&
            "method" in event &&
            event.method === "account/login/start"
        );
        expect(loginRequest).toEqual({
            eventType: "request",
            method: "account/login/start",
            params: {
                type: "apiKey",
                apiKey: "CODEX_ENV_TOKEN",
            }
        });
        await expect(codexAcpAgent.extMethod("authentication/status", {})).resolves.toEqual({type: "api-key"});
    });

    it('should fall back to OPENAI_API_KEY from the environment', async () => {
        const envFixture = createTestFixture();
        const codexAcpAgent = envFixture.getCodexAcpAgent();
        vi.stubEnv(CODEX_API_KEY_ENV_VAR, "");
        vi.stubEnv(OPENAI_API_KEY_ENV_VAR, "OPENAI_ENV_TOKEN");

        await codexAcpAgent.initialize({protocolVersion: 1});
        await envFixture.getCodexAcpClient().logout();
        envFixture.clearCodexConnectionDump();

        await codexAcpAgent.authenticate({methodId: "api-key"});

        const transportEvents = envFixture.getCodexConnectionEvents([]);
        const loginRequest = transportEvents.find(event =>
            event.eventType === "request" &&
            "method" in event &&
            event.method === "account/login/start"
        );
        expect(loginRequest).toEqual({
            eventType: "request",
            method: "account/login/start",
            params: {
                type: "apiKey",
                apiKey: "OPENAI_ENV_TOKEN",
            }
        });
        await expect(codexAcpAgent.extMethod("authentication/status", {})).resolves.toEqual({type: "api-key"});
    });

    it('should report a clear error when the selected API key env var is missing', async () => {
        const envFixture = createTestFixture();
        const codexAcpAgent = envFixture.getCodexAcpAgent();
        vi.stubEnv(CODEX_API_KEY_ENV_VAR, "");
        vi.stubEnv(OPENAI_API_KEY_ENV_VAR, "");

        await expect(codexAcpAgent.authenticate({methodId: "api-key"}))
            .rejects.toThrow(`${CODEX_API_KEY_ENV_VAR} or ${OPENAI_API_KEY_ENV_VAR} is not set`);
    });

    it('should not start ChatGPT login when already authenticated', async () => {
        const chatGptFixture = createCodexMockTestFixture();
        const codexAppServerClient = chatGptFixture.getCodexAppServerClient();
        const accountReadSpy = vi.spyOn(codexAppServerClient, "accountRead").mockResolvedValue({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            requiresOpenaiAuth: false,
        });
        const accountLoginSpy = vi.spyOn(codexAppServerClient, "accountLogin");

        await expect(chatGptFixture.getCodexAcpAgent().authenticate({methodId: "chat-gpt"}))
            .resolves.toEqual({});

        expect(accountReadSpy).toHaveBeenCalledWith({refreshToken: true});
        expect(accountLoginSpy).not.toHaveBeenCalled();
    });

    it('should authenticate with a gateway', async () => {
        const gatewayFixture = createTestFixture();
        const codexAcpAgent = gatewayFixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
                auth: {
                    _meta: {
                        gateway: true,
                    }
                }
            }
        });
        await gatewayFixture.getCodexAcpClient().logout();

        const authRequest: CodexAuthRequest = {
            methodId: "gateway",
            _meta: {
                "gateway": {
                    baseUrl: "https://www.example.com",
                    headers: {
                        "Custom-Auth-Header": "TOKEN"
                    }
                }
            }
        };

        await codexAcpAgent.authenticate(authRequest);
        expect(await gatewayFixture.getCodexAcpClient().authRequired()).toBe(false);

        const authenticatedResponse = await gatewayFixture.getCodexAcpAgent().extMethod("authentication/status", {});
        expect(authenticatedResponse).toEqual({type: "gateway", name: "custom-gateway"});

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        expect(newSessionResponse.sessionId).toBeDefined();
    });

    it('should show account in /status for api key auth and hide it for gateway auth', async () => {
        const authFixture = createTestFixture();
        const codexAcpAgent = authFixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
                auth: {
                    _meta: {
                        gateway: true,
                    }
                }
            }
        });
        await authFixture.getCodexAcpClient().logout();

        await codexAcpAgent.authenticate({
            methodId: "api-key",
            _meta: { "api-key": { apiKey: "TOKEN" } }
        });
        const apiKeySession = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        authFixture.clearAcpConnectionDump();

        await codexAcpAgent.prompt({
            sessionId: apiKeySession.sessionId,
            prompt: [{ type: "text", text: "/status" }]
        });

        const apiKeyStatusDump = authFixture.getAcpConnectionDump([]);
        expect(apiKeyStatusDump).toContain("**Account:** API key configured");

        await codexAcpAgent.authenticate({
            methodId: "gateway",
            _meta: {
                "gateway": {
                    baseUrl: "https://www.example.com",
                    headers: {
                        "Custom-Auth-Header": "TOKEN"
                    }
                }
            }
        });
        const gatewaySession = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        authFixture.clearAcpConnectionDump();

        await codexAcpAgent.prompt({
            sessionId: gatewaySession.sessionId,
            prompt: [{ type: "text", text: "/status" }]
        });

        const gatewayStatusDump = authFixture.getAcpConnectionDump([]);
        expect(gatewayStatusDump).toContain("**Account:** not logged in");
    });

    it('supports legacy authentication/logout ext method', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const logoutSpy = vi.spyOn(codexAcpAgent, "logout").mockResolvedValue();

        await expect(codexAcpAgent.extMethod("authentication/logout", {})).resolves.toEqual({});
        expect(logoutSpy).toHaveBeenCalledWith({});
    });

    it('prefetches session additional skill roots before thread start', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        const listSkillsSpy = vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({ data: [] });
        const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
            thread: { id: "thread-id" } as any,
            model: "gpt-5",
            modelProvider: "openai",
            cwd: "/workspace",
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            reasoningEffort: "medium",
        } as any);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [{
                id: "gpt-5",
                model: "gpt-5",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "gpt-5",
                description: "test model",
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "balanced" }],
                defaultReasoningEffort: "medium",
                inputModalities: ["text"],
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: true
            }],
            nextCursor: null
        });

        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: {
                additionalRoots: ["/skills/one", " /skills/two ", 7]
            }
        });

        expect(listSkillsSpy).toHaveBeenCalledWith({
            cwds: ["/workspace", "/skills/one", "/skills/two"],
            forceReload: true,
        });
        expect(listSkillsSpy.mock.invocationCallOrder[0]!).toBeLessThan(threadStartSpy.mock.invocationCallOrder[0]!);
    });

    it('prefers ACP additional directories over legacy meta roots for new session skill discovery', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        const extraRootsSetSpy = vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        const listSkillsSpy = vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
            thread: {id: "thread-id"} as any,
            model: "gpt-5",
            reasoningEffort: "medium",
            serviceTier: null,
        } as any);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });

        const session = await codexAcpClient.newSession({
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra", "/workspace", "/workspace/extra"],
            mcpServers: [],
            _meta: {
                additionalRoots: ["/skills/one", "/workspace/extra", "/workspace"],
            },
        });

        expect(session.additionalDirectories).toEqual(["/workspace/extra"]);
        expect(extraRootsSetSpy).toHaveBeenCalledWith({
            extraRoots: ["/workspace/extra/.agents/skills"],
        });
        expect(listSkillsSpy).toHaveBeenCalledWith({
            cwds: ["/workspace", "/workspace/extra"],
            forceReload: true,
        });
        expect(extraRootsSetSpy.mock.invocationCallOrder[0]!).toBeLessThan(threadStartSpy.mock.invocationCallOrder[0]!);
        expect(listSkillsSpy.mock.invocationCallOrder[0]!).toBeLessThan(threadStartSpy.mock.invocationCallOrder[0]!);

        const threadStartRequest = threadStartSpy.mock.calls[0]![0];
        expect(threadStartRequest.config?.["projects"]).toEqual({
            "/workspace": {trust_level: "trusted"},
            "/workspace/extra": {trust_level: "trusted"},
        });
        expect(threadStartRequest.config?.["sandbox_workspace_write"]).toEqual({
            writable_roots: ["/workspace/extra"],
        });
    });

    it('applies ACP additional directories to resumed and loaded sessions explicitly', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue({
            thread: {id: "thread-id"} as any,
            model: "gpt-5",
            reasoningEffort: "medium",
            serviceTier: null,
        } as any);
        const threadReadSpy = vi.spyOn(codexAppServerClient, "threadRead").mockResolvedValue({
            thread: {id: "thread-id"} as any,
        });
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });

        const resumed = await codexAcpClient.resumeSession({
            sessionId: "resume-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/resume-extra"],
        });
        const loaded = await codexAcpClient.loadSession({
            sessionId: "load-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/load-extra"],
            mcpServers: [],
        });

        expect(resumed.additionalDirectories).toEqual(["/workspace/resume-extra"]);
        expect(loaded.additionalDirectories).toEqual(["/workspace/load-extra"]);
        expect(threadResumeSpy.mock.calls[0]![0].config?.["projects"]).toEqual({
            "/workspace": {trust_level: "trusted"},
            "/workspace/resume-extra": {trust_level: "trusted"},
        });
        expect(threadResumeSpy.mock.calls[1]![0].config?.["projects"]).toEqual({
            "/workspace": {trust_level: "trusted"},
            "/workspace/load-extra": {trust_level: "trusted"},
        });
        expect(threadReadSpy).toHaveBeenCalledWith({
            threadId: "thread-id",
            includeTurns: true,
        });
    });

    it('uses configured model provider when resuming sessions without an explicit provider', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({
            config: {
                model_provider: "azure",
            },
        } as any);
        const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue({
            thread: {id: "thread-id"} as any,
            model: "gpt-5",
            reasoningEffort: "medium",
            serviceTier: null,
        } as any);
        vi.spyOn(codexAppServerClient, "threadRead").mockResolvedValue({
            thread: {id: "thread-id"} as any,
        });
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });

        await codexAcpClient.resumeSession({
            sessionId: "resume-id",
            cwd: "/workspace",
        });
        await codexAcpClient.loadSession({
            sessionId: "load-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(threadResumeSpy.mock.calls[0]![0].modelProvider).toBe("azure");
        expect(threadResumeSpy.mock.calls[1]![0].modelProvider).toBe("azure");
    });

    it('tracks configured model provider auth state for resumed and loaded sessions', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const getAccountSpy = vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: true,
        });
        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({
            config: {
                model_provider: "azure",
            },
        } as any);
        const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue({
            thread: {id: "thread-id"} as any,
            model: "gpt-5",
            modelProvider: "azure",
            reasoningEffort: "medium",
            serviceTier: null,
        } as any);
        vi.spyOn(codexAppServerClient, "threadRead").mockResolvedValue({
            thread: {id: "thread-id", turns: []} as any,
        });
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });

        await codexAcpAgent.resumeSession({
            sessionId: "resume-id",
            cwd: "/workspace",
        });
        await codexAcpAgent.loadSession({
            sessionId: "load-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(threadResumeSpy.mock.calls[0]![0].modelProvider).toBe("azure");
        expect(threadResumeSpy.mock.calls[1]![0].modelProvider).toBe("azure");
        expect(getAccountSpy).not.toHaveBeenCalled();
        expect(codexAcpAgent.getSessionState("resume-id")).toMatchObject({
            account: null,
            authConfigured: true,
            authProvider: "azure",
        });
        expect(codexAcpAgent.getSessionState("load-id")).toMatchObject({
            account: null,
            authConfigured: true,
            authProvider: "azure",
        });
    });

    it('rejects malformed ACP additional directories', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();

        await expect(codexAcpClient.newSession({
            cwd: "/workspace",
            additionalDirectories: ["relative"],
            mcpServers: [],
        })).rejects.toThrow("additionalDirectories entries must be absolute paths");
        await expect(codexAcpClient.newSession({
            cwd: "/workspace",
            additionalDirectories: [""],
            mcpServers: [],
        })).rejects.toThrow("additionalDirectories entries must not be empty");
        await expect(codexAcpClient.newSession({
            cwd: "/workspace",
            additionalDirectories: [null],
            mcpServers: [],
        } as unknown as acp.NewSessionRequest)).rejects.toThrow("additionalDirectories entries must be strings");
    });

    it('sanitizes whitespace in ACP MCP server names before adding them to Codex config', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({
            config: {
                mcp_servers: {
                    shared_mcp: {
                        url: "https://example.com/mcp",
                    },
                },
            },
        } as any);
        const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
            thread: {id: "thread-id"} as any,
            model: "gpt-5",
            reasoningEffort: "medium",
            serviceTier: null,
        } as any);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });

        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [{
                name: "shared mcp",
                command: "npx",
                args: ["shared"],
                env: [],
            }, {
                name: "stdio server\tone",
                command: "npx",
                args: ["stdio"],
                env: [{name: "EXAMPLE", value: "1"}],
            }, {
                type: "http",
                name: "http\nserver\u00a0two",
                url: "https://example.com/http",
                headers: [{name: "Authorization", value: "Bearer token"}],
            }],
        });

        const threadStartRequest = threadStartSpy.mock.calls[0]![0];
        expect(threadStartRequest.config?.["mcp_servers"]).toEqual({
            stdio_server_one: {
                command: "npx",
                args: ["stdio"],
                env: {EXAMPLE: "1"},
            },
            http_server_two: {
                url: "https://example.com/http",
                http_headers: {Authorization: "Bearer token"},
            },
        });
    });

    it('waits for typed mcp startup status updates and returns terminal states', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        const startupPromise = codexAcpClient.awaitMcpServerStartup(
            ["alpha", "beta"],
            codexAppServerClient.getMcpServerStartupVersion()
        );

        mockFixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "thread-id", name: "alpha", status: "starting", error: null }
        });
        mockFixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "thread-id", name: "beta", status: "starting", error: null }
        });
        mockFixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "thread-id", name: "alpha", status: "ready", error: null }
        });
        mockFixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "thread-id", name: "beta", status: "ready", error: null }
        });

        const startup = await startupPromise;

        expect(startup).toEqual({
            ready: ["alpha", "beta"],
            failed: [],
            cancelled: [],
        });
    });

    it('forwards failed MCP startup as failed tool call updates after new session', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        vi.spyOn(codexAcpAgent, "checkAuthorization").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
            thread: { id: "thread-id" } as any,
            model: "gpt-5",
            reasoningEffort: "medium",
        } as any);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [{
                id: "gpt-5",
                name: "GPT-5",
                inputModalities: ["text"],
                supportedReasoningEfforts: [],
            }],
            hasMore: false,
        } as any);
        vi.spyOn(codexAppServerClient, "accountRead").mockResolvedValue({
            requiresOpenaiAuth: false,
            account: null,
        } as any);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({ data: [] });
        const mcpServer = {
            name: "broken-mcp",
            command: "npx",
            args: ["broken"],
            env: [],
        } as unknown as acp.McpServerStdio;

        const session = await codexAcpAgent.newSession({
            cwd: "/workspace",
            mcpServers: [mcpServer]
        });

        mockFixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "thread-id", name: "broken-mcp", status: "failed", error: "boom" }
        });

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump).toContain('"sessionId": "thread-id"');
            expect(dump).toContain('"sessionUpdate": "tool_call"');
            expect(dump).toContain('"toolCallId": "mcp_startup.broken-mcp"');
            expect(dump).toContain('MCP server `broken-mcp` failed to start: boom');
        });

        expect(session.sessionId).toBe("thread-id");
    });

    it('prefetches skills before turn start', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        const listSkillsSpy = vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({ data: [] });
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        } as any);
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: "session-id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        } as any);

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId: "session-id",
            cwd: "/workspace"
        }));

        const promptRequest: acp.PromptRequest = {
            sessionId: "session-id",
            prompt: [{ type: "text", text: "Hello" }],
        };
        await codexAcpAgent.prompt(promptRequest);

        expect(listSkillsSpy).toHaveBeenCalledWith({
            cwds: ["/workspace"],
            forceReload: true,
        });
        expect(listSkillsSpy.mock.invocationCallOrder[0]!).toBeLessThan(turnStartSpy.mock.invocationCallOrder[0]!);
    });

    it('applies ACP additional directories to turn skill discovery and sandbox policy', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        const extraRootsSetSpy = vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        const listSkillsSpy = vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        } as any);
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: "session-id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        } as any);

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId: "session-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
        }));

        await codexAcpAgent.prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "Hello" }],
        });

        expect(extraRootsSetSpy).toHaveBeenCalledWith({
            extraRoots: ["/workspace/extra/.agents/skills"],
        });
        expect(listSkillsSpy).toHaveBeenCalledWith({
            cwds: ["/workspace", "/workspace/extra"],
            forceReload: true,
        });
        expect(turnStartSpy.mock.calls[0]![0].sandboxPolicy).toMatchObject({
            type: "workspaceWrite",
            writableRoots: ["/workspace/extra"],
        });
    });

    function loadNotifications(){
        //TODO collect logs form dev run and then load them from file to speedup
        const serverNotifications: ServerNotification[] = [
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "He", }},
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "ll", }},
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "o!", }},
        ];
        function onServerNotification(_sessionId: string, callback: (event: ServerNotification) => void){
            for (const notification of serverNotifications) {
                callback(notification);
            }
        }
        return onServerNotification;
    }

    function createTurn(id: string, status: "inProgress" | "completed" | "interrupted") {
        return {
            id,
            items: [],
            itemsView: "notLoaded" as const,
            status,
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        };
    }

    function createTurnCompletedNotification(threadId: string, turnId: string): ServerNotification {
        return {
            method: "turn/completed",
            params: {
                threadId,
                turn: createTurn(turnId, "completed"),
            },
        };
    }

    async function flushAsyncWork(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
        let resolve: (value: T) => void = () => {};
        const promise = new Promise<T>((innerResolve) => {
            resolve = innerResolve;
        });
        return {promise, resolve};
    }

    it('should map events from dump', async () => {
        fixture.getCodexAppServerClient().onServerNotification = loadNotifications();

        const codexAcpAgent = fixture.getCodexAcpAgent();

        fixture.getCodexAppServerClient().listSkills = vi.fn().mockResolvedValue({ data: [] });
        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: "id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });
        const sessionState: SessionState = createTestSessionState({
            sessionId: "id",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: ""}] });

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/output-acp-events.json");

    });

    it('should not duplicate messages on follow-up prompts', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: "id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });

        const sessionState: SessionState = createTestSessionState({
            sessionId: "id",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        // First prompt - registers first notification handler
        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: "First message"}] });

        // Follow-up prompt - should NOT accumulate handlers
        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: "Follow-up message"}] });

        mockFixture.clearAcpConnectionDump();

        // Trigger notifications after both prompts - should produce only 3 events, not 6
        const serverNotifications: ServerNotification[] = [
            { method: "item/agentMessage/delta", params: { threadId: "id", turnId: "string", itemId: "string", delta: "He", }},
            { method: "item/agentMessage/delta", params: { threadId: "id", turnId: "string", itemId: "string", delta: "ll", }},
            { method: "item/agentMessage/delta", params: { threadId: "id", turnId: "string", itemId: "string", delta: "o!", }},
        ];
        for (const notification of serverNotifications) {
            mockFixture.sendServerNotification(notification);
        }

        // Wait for async handlers to complete
        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/follow-up-no-duplicates.json");
    });

    it('should handle multiple sessions independently', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });

        const sessionState1: SessionState = createTestSessionState({
            sessionId: "session-1",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        const sessionState2: SessionState = createTestSessionState({
            sessionId: "session-2",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockImplementation((sessionId: string) => {
            return sessionId === "session-1" ? sessionState1 : sessionState2;
        });

        // awaitTurnCompleted is per-turn; resolve the matching thread and turn.
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation((threadId: string, turnId: string) => Promise.resolve({
            threadId,
            turn: createTurn(turnId, "completed")
        }));

        // Start prompts for two different sessions
        await codexAcpAgent.prompt({ sessionId: "session-1", prompt: [{type: "text", text: "Message to session 1"}] });
        await codexAcpAgent.prompt({ sessionId: "session-2", prompt: [{type: "text", text: "Message to session 2"}] });

        mockFixture.clearAcpConnectionDump();

        // Each notification carries the threadId of the session it belongs to,
        // and must only be dispatched to that session.
        const serverNotifications: ServerNotification[] = [
            { method: "item/agentMessage/delta", params: { threadId: "session-1", turnId: "string", itemId: "string", delta: "Hello-1", }},
            { method: "item/agentMessage/delta", params: { threadId: "session-2", turnId: "string", itemId: "string", delta: "Hello-2", }},
        ];
        for (const notification of serverNotifications) {
            mockFixture.sendServerNotification(notification);
        }

        // Wait for async handlers to complete
        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThanOrEqual(2);
        });

        // Should have exactly 2 events - the session-1 delta only on session-1, and
        // the session-2 delta only on session-2 (no cross-session pollution).
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/multiple-sessions.json");
    });

    it('should complete concurrent prompts by matching thread and turn id', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const turnIds = new Map([
            ["session-1", "turn-1"],
            ["session-2", "turn-2"],
        ]);
        const turnStart = vi.fn().mockImplementation((params: TurnStartParams) => Promise.resolve({
            turn: createTurn(turnIds.get(params.threadId) ?? "unknown-turn", "inProgress"),
        }));
        mockFixture.getCodexAppServerClient().turnStart = turnStart;

        const sessionState1: SessionState = createTestSessionState({
            sessionId: "session-1",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        const sessionState2: SessionState = createTestSessionState({
            sessionId: "session-2",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockImplementation((sessionId: string) => {
            return sessionId === "session-1" ? sessionState1 : sessionState2;
        });

        const prompt1 = codexAcpAgent.prompt({ sessionId: "session-1", prompt: [{type: "text", text: "Message to session 1"}] });
        const prompt2 = codexAcpAgent.prompt({ sessionId: "session-2", prompt: [{type: "text", text: "Message to session 2"}] });

        await vi.waitFor(() => {
            expect(turnStart).toHaveBeenCalledTimes(2);
        });

        let prompt1Settled = false;
        void prompt1.then(() => {
            prompt1Settled = true;
        }, () => {
            prompt1Settled = true;
        });

        mockFixture.sendServerNotification(createTurnCompletedNotification("session-1", "old-turn"));
        await flushAsyncWork();
        expect(prompt1Settled).toBe(false);

        mockFixture.sendServerNotification(createTurnCompletedNotification("session-2", "turn-2"));
        await expect(prompt2).resolves.toMatchObject({stopReason: "end_turn"});
        expect(prompt1Settled).toBe(false);

        mockFixture.sendServerNotification(createTurnCompletedNotification("session-1", "turn-1"));
        await expect(prompt1).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it('should handle a turn completion that arrives before awaitTurnCompleted is called', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockImplementation((params: TurnStartParams) => {
            mockFixture.sendServerNotification(createTurnCompletedNotification(params.threadId, "fast-turn"));
            return Promise.resolve({
                turn: createTurn("fast-turn", "inProgress"),
            });
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(createTestSessionState({
            sessionId: "fast-session",
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        }));

        await expect(codexAcpAgent.prompt({
            sessionId: "fast-session",
            prompt: [{type: "text", text: "Fast completion"}],
        })).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it('cancels an active prompt when the ACP prompt request is cancelled', async () => {
        const { mockFixture, sessionState } = setupPromptFixture();
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async ({threadId, turnId}) => {
                turnCompleted.resolve({
                    threadId,
                    turn: createTurn(turnId, "interrupted"),
                });
            });
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "long running prompt" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        controller.abort();

        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                turnId: "turn-id",
            });
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it('returns success when a cancelled ACP prompt request completes before interruption wins', async () => {
        const { mockFixture, sessionState } = setupPromptFixture();
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);
        const turnInterrupt = deferred<void>();
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockReturnValue(turnInterrupt.promise);
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "long running prompt" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        controller.abort();
        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                turnId: "turn-id",
            });
        });

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "turn-id",
                itemId: "tail-item",
                delta: "tail output",
            },
        });
        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(mockFixture.getAcpConnectionDump([])).toContain("tail output");
        turnInterrupt.resolve(undefined);
    });

    it('interrupts a late-started turn after the ACP prompt request is cancelled', async () => {
        const { mockFixture } = setupPromptFixture();
        const turnStart = deferred<{turn: ReturnType<typeof createTurn>}>();
        const turnStartCalled = deferred<void>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockImplementation(async () => {
                turnStartCalled.resolve();
                return await turnStart.promise;
            });
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async ({threadId, turnId}) => {
                turnCompleted.resolve({
                    threadId,
                    turn: createTurn(turnId, "interrupted"),
                });
            });
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "long running prompt" }],
        }, controller.signal);

        await turnStartCalled.promise;
        controller.abort();

        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
        expect(turnInterruptSpy).not.toHaveBeenCalled();

        turnStart.resolve({turn: createTurn("late-turn-id", "inProgress")});
        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                turnId: "late-turn-id",
            });
        });
    });

    it('returns cancelled when the ACP prompt request is cancelled during startup work', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture();
        const skillsRefresh = deferred<{data: []}>();
        const listSkillsSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "listSkills")
            .mockReturnValue(skillsRefresh.promise);
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "long running prompt" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(listSkillsSpy).toHaveBeenCalled();
        });

        controller.abort();
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        skillsRefresh.resolve({data: []});
        await flushAsyncWork();
        expect(turnStartSpy).not.toHaveBeenCalled();
    });

    it('should send attachments as prompt items', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        const realTurnStart = codexAppServerClient.turnStart.bind(codexAppServerClient);
        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation(async (params) => {
            await realTurnStart(params);
            return {turn: createTurn("turn-id", "inProgress")};
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: "session-id",
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

        const sessionState: SessionState = createTestSessionState();
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        const prompt: acp.ContentBlock[] = [
            { type: "text", text: "Hello" },
            { type: "image", mimeType: "image/png", data: "abc123", uri: "https://example.com/image.png" },
            { type: "resource_link", name: "report.txt", uri: "file:///tmp/report.txt" },
            { type: "resource", resource: { uri: "file:///tmp/notes.txt", text: "Notes body" } as acp.EmbeddedResourceResource },
            { type: "resource", resource: { uri: "file:///tmp/pixel.png", mimeType: "image/png", blob: "iVBORw0KGgo=" } as acp.EmbeddedResourceResource },
            { type: "resource", resource: { uri: "file:///tmp/archive.bin", mimeType: "application/octet-stream", blob: "AAEC" } as acp.EmbeddedResourceResource },
        ];

        await codexAcpAgent.prompt({ sessionId: "session-id", prompt });

        await expect(mockFixture.getCodexConnectionDump(ignoredFields)).toMatchFileSnapshot("data/send-attachments-turn-start.json");
    });

    it('should fail on wrong sessionId', async () => {
        const sessionId = "not-existing-session";

        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        fixture.clearCodexConnectionDump();

        await expect(
            fixture.getCodexAcpAgent().resumeSession({cwd: "", sessionId: sessionId})
        ).rejects.toThrow("invalid session id");
    });

    it('should return available builtin commands', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        vi.spyOn(mockFixture.getCodexAcpClient(), "listSkills").mockResolvedValue({ data: [] });

        // @ts-expect-error - exercising private helper
        await codexAcpAgent.availableCommands.publish(createTestSessionState({
            sessionId: "session-id",
            cwd: "/workspace",
        }));

        expect(mockFixture.getCodexAcpClient().listSkills).toHaveBeenCalledWith({
            cwds: ["/workspace"],
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/available-commands-build-in.json");
    });

    it('should return available commands from skills list', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        vi.spyOn(mockFixture.getCodexAcpClient(), "listSkills").mockResolvedValue({
            data: [{
                cwd: "/workspace",
                skills: [{
                    name: "build",
                    description: "Build the project",
                    shortDescription: "Build",
                    path: "/workspace",
                    scope: "user",
                    enabled: true
                }],
                errors: []
            }]
        });

        // @ts-expect-error - exercising private helper
        await codexAcpAgent.availableCommands.publish(createTestSessionState({
            sessionId: "session-id",
            cwd: "/workspace",
            additionalDirectories: ["/workspace/extra"],
        }));

        expect(mockFixture.getCodexAcpClient().listSkills).toHaveBeenCalledWith({
            cwds: ["/workspace", "/workspace/extra"],
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/available-commands-skills.json");
    });

    it('handles builtin slash command locally', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const sessionState: SessionState = createTestSessionState();
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({ sessionId: "session-id", prompt: [{ type: "text", text: "/status" }] });
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-status.json");
    });

    it('passes skill slash commands through to Codex', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture();

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/$imagegen create a hero image" }],
        });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            input: [{
                type: "text",
                text: "/$imagegen create a hero image",
                text_elements: []
            }]
        }));
        expect(mockFixture.getAcpConnectionDump([])).toBe("");
    });

    it('handles review slash commands through Codex app server', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture();
        const reviewStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "reviewStart")
            .mockResolvedValue(createReviewStartResponse());

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review" }],
        });
        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review focus on API compatibility" }],
        });
        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review-branch main" }],
        });
        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review-commit abc123" }],
        });

        expect(reviewStartSpy).toHaveBeenNthCalledWith(1, {
            threadId: "session-id",
            target: { type: "uncommittedChanges" },
            delivery: "inline",
        });
        expect(reviewStartSpy).toHaveBeenNthCalledWith(2, {
            threadId: "session-id",
            target: { type: "custom", instructions: "focus on API compatibility" },
            delivery: "inline",
        });
        expect(reviewStartSpy).toHaveBeenNthCalledWith(3, {
            threadId: "session-id",
            target: { type: "baseBranch", branch: "main" },
            delivery: "inline",
        });
        expect(reviewStartSpy).toHaveBeenNthCalledWith(4, {
            threadId: "session-id",
            target: { type: "commit", sha: "abc123", title: null },
            delivery: "inline",
        });
        expect(turnStartSpy).not.toHaveBeenCalled();
    });

    it('waits for review slash command completion', async () => {
        const { mockFixture } = setupPromptFixture();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "reviewStart")
            .mockResolvedValue(createReviewStartResponse());
        let completeReview: (value: TurnCompletedNotification) => void = () => {};
        const reviewCompletedPromise = new Promise<TurnCompletedNotification>((resolve) => {
            completeReview = resolve;
        });
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(reviewCompletedPromise);

        let promptResolved = false;
        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review" }],
        }).then((response) => {
            promptResolved = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(mockFixture.getCodexAppServerClient().awaitTurnCompleted).toHaveBeenCalledWith(
                "session-id",
                "review-turn-id",
            );
        });
        await Promise.resolve();
        expect(promptResolved).toBe(false);

        completeReview(createReviewCompletedNotification());
        await expect(promptPromise).resolves.toEqual(expect.objectContaining({
            stopReason: "end_turn",
        }));
        expect(promptResolved).toBe(true);
    });

    it('interrupts a late-started review slash command after the ACP prompt request is cancelled', async () => {
        const { mockFixture } = setupPromptFixture();
        const reviewStart = deferred<ReviewStartResponse>();
        const reviewStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "reviewStart")
            .mockReturnValue(reviewStart.promise);
        const reviewCompleted = deferred<TurnCompletedNotification>();
        const awaitTurnCompletedSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(reviewCompleted.promise);
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async ({threadId, turnId}) => {
                reviewCompleted.resolve({
                    threadId,
                    turn: createTurn(turnId, "interrupted"),
                });
            });
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(reviewStartSpy).toHaveBeenCalled();
        });

        controller.abort();
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        reviewStart.resolve(createReviewStartResponse("review-thread-id", "review-turn-id"));

        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "review-thread-id",
                turnId: "review-turn-id",
            });
        });
        expect(awaitTurnCompletedSpy).toHaveBeenCalledWith("review-thread-id", "review-turn-id");
    });

    it('returns cancelled when review slash command is interrupted', async () => {
        const { mockFixture } = setupPromptFixture();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "reviewStart")
            .mockResolvedValue(createReviewStartResponse());
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockResolvedValue(createReviewCompletedNotification("interrupted"));

        const response = await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review" }],
        });

        expect(response.stopReason).toBe("cancelled");
    });

    it('waits for compact slash command completion', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture();
        const compactStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "threadCompactStart")
            .mockResolvedValue({});

        let promptResolved = false;
        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/compact" }],
        }).then((response) => {
            promptResolved = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(compactStartSpy).toHaveBeenCalledWith({ threadId: "session-id" });
        });
        await Promise.resolve();
        expect(promptResolved).toBe(false);

        mockFixture.sendServerNotification({
            method: "thread/compacted",
            params: { threadId: "session-id", turnId: "compact-turn-id" },
        });

        await expect(promptPromise).resolves.toEqual(expect.objectContaining({
            stopReason: "end_turn",
        }));
        expect(promptResolved).toBe(true);
        expect(turnStartSpy).not.toHaveBeenCalled();
        expect(mockFixture.getAcpConnectionDump([])).toContain("Context compacted");
    });

    it('handles goal slash commands through Codex app server', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture();
        const goalRunSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "runGoalSet")
            .mockResolvedValue({
                threadId: "session-id",
                turn: createTurn("goal-turn-id", "completed"),
            });
        const goalClearSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "runGoalClear")
            .mockResolvedValue(undefined);

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        });
        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal pause" }],
        });
        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal resume" }],
        });
        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal clear" }],
        });

        expect(goalRunSpy).toHaveBeenNthCalledWith(1, {
            threadId: "session-id",
            objective: "Ship the migration and keep tests green",
            status: "active",
        }, expect.any(Function));
        expect(goalRunSpy).toHaveBeenNthCalledWith(2, {
            threadId: "session-id",
            status: "paused",
        });
        expect(goalRunSpy).toHaveBeenNthCalledWith(3, {
            threadId: "session-id",
            status: "active",
        }, expect.any(Function));
        expect(goalClearSpy).toHaveBeenCalledWith({ threadId: "session-id" });
        expect(turnStartSpy).not.toHaveBeenCalled();
    });

    it('waits for goal slash command turn routing', async () => {
        const { mockFixture } = setupPromptFixture();
        const goal = createThreadGoal();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "threadGoalSet")
            .mockResolvedValue({ goal });
        const awaitTurnCompletedSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted");

        let promptResolved = false;
        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        }).then((response) => {
            promptResolved = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(mockFixture.getCodexAppServerClient().threadGoalSet).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });
        await Promise.resolve();
        expect(promptResolved).toBe(false);
        expect(mockFixture.getCodexAppServerClient().awaitTurnCompleted).not.toHaveBeenCalled();

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });
        mockFixture.sendServerNotification({
            method: "thread/status/changed",
            params: {
                threadId: "session-id",
                status: {
                    type: "active",
                    activeFlags: [],
                },
            },
        });
        await Promise.resolve();
        expect(promptResolved).toBe(false);
        expect(mockFixture.getCodexAppServerClient().awaitTurnCompleted).not.toHaveBeenCalled();

        mockFixture.sendServerNotification({
            method: "turn/started",
            params: {
                threadId: "session-id",
                turn: createTurn("goal-turn-id", "inProgress"),
            },
        });
        await Promise.resolve();
        expect(promptResolved).toBe(false);
        expect(mockFixture.getCodexAppServerClient().awaitTurnCompleted).not.toHaveBeenCalled();

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: "I",
            },
        });
        await Promise.resolve();
        expect(promptResolved).toBe(false);

        mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));

        await vi.waitFor(() => {
            expect(promptResolved).toBe(true);
        });
        await expect(promptPromise).resolves.toEqual(expect.objectContaining({
            stopReason: "end_turn",
        }));
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
    });

    it('does not complete no-turn goal slash command before the goal update and runtime grace are handled', async () => {
        const { mockFixture } = setupPromptFixture();
        const goal = createThreadGoal({updatedAt: 1710000100});
        const threadGoalSetSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "threadGoalSet")
            .mockResolvedValue({ goal });
        let promptResolved = false;

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        }).then((response) => {
            promptResolved = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });
        await flushAsyncWork();
        expect(promptResolved).toBe(false);

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });

        await flushAsyncWork();
        expect(promptResolved).toBe(false);

        await expect(promptPromise).resolves.toEqual(expect.objectContaining({
            stopReason: "end_turn",
        }));
        expect(mockFixture.getAcpConnectionEvents([])).toContainEqual(expect.objectContaining({
            args: [expect.objectContaining({
                update: {
                    sessionUpdate: "session_info_update",
                    _meta: {
                        codex: {
                            goal: {
                                objective: "Ship the migration and keep tests green",
                                status: "active",
                                tokenBudget: null,
                            },
                        },
                    },
                },
            })],
        }));
    });

    it('completes goal slash command when a turn routes after the goal update', async () => {
        const { mockFixture } = setupPromptFixture();
        const goal = createThreadGoal({updatedAt: 1710000150});
        const threadGoalSetSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "threadGoalSet")
            .mockResolvedValue({ goal });
        const awaitTurnCompletedSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockResolvedValue({
                threadId: "session-id",
                turn: createTurn("goal-turn-id", "completed"),
            });
        let promptResolved = false;

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        }).then((response) => {
            promptResolved = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });

        await flushAsyncWork();
        expect(promptResolved).toBe(false);
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: "late goal output",
            },
        });
        await flushAsyncWork();
        expect(promptResolved).toBe(false);

        mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));

        await expect(promptPromise).resolves.toEqual(expect.objectContaining({
            stopReason: "end_turn",
        }));
        expect(promptResolved).toBe(true);
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
    });

    it('waits for goal turn completion after the goal completes before streamed output finishes', async () => {
        const { mockFixture } = setupPromptFixture();
        const goal = createThreadGoal({updatedAt: 1710000160});
        const completedGoal = createThreadGoal({
            status: "complete",
            updatedAt: 1710000170,
            tokensUsed: 42,
            timeUsedSeconds: 8,
        });
        vi.spyOn(mockFixture.getCodexAppServerClient(), "threadGoalSet")
            .mockResolvedValue({ goal });
        let promptResolved = false;

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal tell me a joke" }],
        }).then((response) => {
            promptResolved = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(mockFixture.getCodexAppServerClient().threadGoalSet).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "tell me a joke",
                status: "active",
            });
        });

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });
        mockFixture.sendServerNotification({
            method: "thread/status/changed",
            params: {
                threadId: "session-id",
                status: {
                    type: "active",
                    activeFlags: [],
                },
            },
        });
        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                goal: completedGoal,
            },
        });
        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: "Why",
            },
        });
        await flushAsyncWork();
        expect(promptResolved).toBe(false);

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: " did the test wait?",
            },
        });
        mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));

        await expect(promptPromise).resolves.toEqual(expect.objectContaining({
            stopReason: "end_turn",
        }));
        expect(promptResolved).toBe(true);
    });

    it('does not start the no-turn grace period before the goal update is handled', async () => {
        vi.useFakeTimers();
        try {
            const mockFixture = createCodexMockTestFixture();
            const codexAppServerClient = mockFixture.getCodexAppServerClient();
            const goal = createThreadGoal({updatedAt: 1710000200});
            const threadGoalSet = deferred<{goal: ThreadGoal}>();
            const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
                .mockReturnValue(threadGoalSet.promise);
            const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted")
                .mockResolvedValue({
                    threadId: "session-id",
                    turn: createTurn("goal-turn-id", "completed"),
                });
            let resultSettled = false;

            const resultPromise = codexAppServerClient.runGoalSet({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            }, undefined, undefined).finally(() => {
                resultSettled = true;
            });

            await vi.waitFor(() => {
                expect(threadGoalSetSpy).toHaveBeenCalledWith({
                    threadId: "session-id",
                    objective: "Ship the migration and keep tests green",
                    status: "active",
                });
            });

            threadGoalSet.resolve({goal});
            await vi.advanceTimersByTimeAsync(10_000);
            await Promise.resolve();
            expect(resultSettled).toBe(false);
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

            mockFixture.sendServerNotification({
                method: "thread/goal/updated",
                params: {
                    threadId: "session-id",
                    turnId: null,
                    goal,
                },
            });
            await Promise.resolve();
            expect(resultSettled).toBe(false);
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

            mockFixture.sendServerNotification({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "session-id",
                    turnId: "goal-turn-id",
                    itemId: "goal-message-id",
                    delta: "late goal output",
                },
            });

            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));
            await vi.advanceTimersByTimeAsync(0);
            await expect(resultPromise).resolves.toMatchObject({
                threadId: "session-id",
                turn: {
                    id: "goal-turn-id",
                    status: "completed",
                },
            });
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('completes goal set when a turn routes after the goal update', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const goal = createThreadGoal({updatedAt: 1710000200});
        const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
            .mockResolvedValue({goal});
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted")
            .mockResolvedValue({
                threadId: "session-id",
                turn: createTurn("goal-turn-id", "completed"),
            });
        let resultSettled = false;

        const resultPromise = codexAppServerClient.runGoalSet({
            threadId: "session-id",
            objective: "Ship the migration and keep tests green",
            status: "active",
        }, undefined, undefined).finally(() => {
            resultSettled = true;
        });

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });
        await flushAsyncWork();
        expect(resultSettled).toBe(false);
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: "late goal output",
            },
        });

        await flushAsyncWork();
        expect(resultSettled).toBe(false);

        mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));
        await expect(resultPromise).resolves.toMatchObject({
            threadId: "session-id",
            turn: {
                id: "goal-turn-id",
                status: "completed",
            },
        });
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
    });

    it('keeps goal set pending while the thread is active before a turn routes', async () => {
        vi.useFakeTimers();
        try {
            const mockFixture = createCodexMockTestFixture();
            const codexAppServerClient = mockFixture.getCodexAppServerClient();
            const goal = createThreadGoal({updatedAt: 1710000225});
            const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
                .mockResolvedValue({goal});
            const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted")
                .mockResolvedValue({
                    threadId: "session-id",
                    turn: createTurn("goal-turn-id", "completed"),
                });
            let resultSettled = false;

            const resultPromise = codexAppServerClient.runGoalSet({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            }, undefined, undefined).finally(() => {
                resultSettled = true;
            });

            await vi.waitFor(() => {
                expect(threadGoalSetSpy).toHaveBeenCalledWith({
                    threadId: "session-id",
                    objective: "Ship the migration and keep tests green",
                    status: "active",
                });
            });

            mockFixture.sendServerNotification({
                method: "thread/goal/updated",
                params: {
                    threadId: "session-id",
                    turnId: null,
                    goal,
                },
            });
            mockFixture.sendServerNotification({
                method: "thread/status/changed",
                params: {
                    threadId: "session-id",
                    status: {
                        type: "active",
                        activeFlags: [],
                    },
                },
            });

            await vi.advanceTimersByTimeAsync(10_000);
            await Promise.resolve();
            expect(resultSettled).toBe(false);
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

            mockFixture.sendServerNotification({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "session-id",
                    turnId: "goal-turn-id",
                    itemId: "goal-message-id",
                    delta: "late goal output",
                },
            });

            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));
            await vi.advanceTimersByTimeAsync(0);
            await expect(resultPromise).resolves.toMatchObject({
                threadId: "session-id",
                turn: {
                    id: "goal-turn-id",
                    status: "completed",
                },
            });
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps goal set pending after turn start until turn completion routes', async () => {
        vi.useFakeTimers();
        try {
            const mockFixture = createCodexMockTestFixture();
            const codexAppServerClient = mockFixture.getCodexAppServerClient();
            const goal = createThreadGoal({updatedAt: 1710000235});
            const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
                .mockResolvedValue({goal});
            const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted")
                .mockResolvedValue({
                    threadId: "session-id",
                    turn: createTurn("goal-turn-id", "completed"),
                });
            const onTurnStarted = vi.fn();
            let resultSettled = false;

            const resultPromise = codexAppServerClient.runGoalSet({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            }, onTurnStarted).finally(() => {
                resultSettled = true;
            });

            await vi.waitFor(() => {
                expect(threadGoalSetSpy).toHaveBeenCalledWith({
                    threadId: "session-id",
                    objective: "Ship the migration and keep tests green",
                    status: "active",
                });
            });

            mockFixture.sendServerNotification({
                method: "thread/goal/updated",
                params: {
                    threadId: "session-id",
                    turnId: null,
                    goal,
                },
            });
            mockFixture.sendServerNotification({
                method: "turn/started",
                params: {
                    threadId: "session-id",
                    turn: createTurn("goal-turn-id", "inProgress"),
                },
            });

            await vi.advanceTimersByTimeAsync(10_000);
            await Promise.resolve();
            expect(onTurnStarted).toHaveBeenCalledWith("goal-turn-id");
            expect(resultSettled).toBe(false);
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

            mockFixture.sendServerNotification({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "session-id",
                    turnId: "goal-turn-id",
                    itemId: "goal-message-id",
                    delta: "late goal output",
                },
            });

            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));
            await vi.advanceTimersByTimeAsync(0);
            await expect(resultPromise).resolves.toMatchObject({
                threadId: "session-id",
                turn: {
                    id: "goal-turn-id",
                    status: "completed",
                },
            });
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('completes goal set when active thread returns idle without routing a turn', async () => {
        vi.useFakeTimers();
        try {
            const mockFixture = createCodexMockTestFixture();
            const codexAppServerClient = mockFixture.getCodexAppServerClient();
            const goal = createThreadGoal({updatedAt: 1710000250});
            const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
                .mockResolvedValue({goal});
            let resultSettled = false;

            const resultPromise = codexAppServerClient.runGoalSet({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            }, undefined, undefined).finally(() => {
                resultSettled = true;
            });

            await vi.waitFor(() => {
                expect(threadGoalSetSpy).toHaveBeenCalledWith({
                    threadId: "session-id",
                    objective: "Ship the migration and keep tests green",
                    status: "active",
                });
            });

            mockFixture.sendServerNotification({
                method: "thread/goal/updated",
                params: {
                    threadId: "session-id",
                    turnId: null,
                    goal,
                },
            });
            mockFixture.sendServerNotification({
                method: "thread/status/changed",
                params: {
                    threadId: "session-id",
                    status: {
                        type: "active",
                        activeFlags: [],
                    },
                },
            });

            await vi.advanceTimersByTimeAsync(10_000);
            await Promise.resolve();
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification({
                method: "thread/status/changed",
                params: {
                    threadId: "session-id",
                    status: { type: "idle" },
                },
            });

            await expect(resultPromise).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('waits for paused goal update before completing goal status set', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const goal = createThreadGoal({status: "paused", updatedAt: 1710000260});
        const threadGoalSet = deferred<{goal: ThreadGoal}>();
        const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
            .mockReturnValue(threadGoalSet.promise);
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        let resultSettled = false;

        const resultPromise = codexAppServerClient.runGoalSet({
            threadId: "session-id",
            status: "paused",
        }).finally(() => {
            resultSettled = true;
        });

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                status: "paused",
            });
        });

        threadGoalSet.resolve({goal});
        await flushAsyncWork();
        expect(resultSettled).toBe(false);
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });

        await expect(resultPromise).resolves.toBeNull();
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
    });

    it('waits for goal cleared notification before completing goal clear', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const threadGoalClear = deferred<{cleared: boolean}>();
        const threadGoalClearSpy = vi.spyOn(codexAppServerClient, "threadGoalClear")
            .mockReturnValue(threadGoalClear.promise);
        let resultSettled = false;

        const resultPromise = codexAppServerClient.runGoalClear({
            threadId: "session-id",
        }).finally(() => {
            resultSettled = true;
        });

        await vi.waitFor(() => {
            expect(threadGoalClearSpy).toHaveBeenCalledWith({
                threadId: "session-id",
            });
        });

        threadGoalClear.resolve({cleared: true});
        await flushAsyncWork();
        expect(resultSettled).toBe(false);

        mockFixture.sendServerNotification({
            method: "thread/goal/cleared",
            params: {
                threadId: "session-id",
            },
        });

        await expect(resultPromise).resolves.toBeUndefined();
    });

    it('interrupts a late-started goal slash command after the ACP prompt request is cancelled', async () => {
        const { mockFixture } = setupPromptFixture();
        const goalCompleted = deferred<TurnCompletedNotification | null>();
        let startGoalTurn: () => void = () => {};
        const goalRunSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "runGoalSet")
            .mockImplementation((_params, onTurnStarted) => {
                startGoalTurn = () => onTurnStarted?.("goal-turn-id");
                return goalCompleted.promise;
            });
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async ({threadId, turnId}) => {
                goalCompleted.resolve({
                    threadId,
                    turn: createTurn(turnId, "interrupted"),
                });
            });
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(goalRunSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            }, expect.any(Function));
        });

        controller.abort();
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
        expect(turnInterruptSpy).not.toHaveBeenCalled();

        startGoalTurn();

        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                turnId: "goal-turn-id",
            });
        });
    });

    it('interrupts a goal slash command when ACP cancel arrives before the first routed turn', async () => {
        const { mockFixture, sessionState } = setupPromptFixture();
        // @ts-expect-error - registering local session state for the ACP cancel path
        mockFixture.getCodexAcpAgent().sessions.set("session-id", sessionState);
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const goal = createThreadGoal();
        const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
            .mockResolvedValue({ goal });
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async ({threadId, turnId}) => {
                mockFixture.sendServerNotification({
                    method: "turn/completed",
                    params: {
                        threadId,
                        turn: createTurn(turnId, "interrupted"),
                    },
                });
            });
        let cancelResolved = false;

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        });

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });

        const cancelPromise = mockFixture.getCodexAcpAgent().cancel({sessionId: "session-id"})
            .then(() => {
                cancelResolved = true;
            });
        await flushAsyncWork();
        expect(cancelResolved).toBe(false);

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: "goal output",
            },
        });

        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                turnId: "goal-turn-id",
            });
        });
        await expect(cancelPromise).resolves.toBeUndefined();
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it('suppresses the first routed goal notification after cancellation marks the turn stale', async () => {
        const { mockFixture } = setupPromptFixture();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const goal = createThreadGoal();
        const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
            .mockResolvedValue({ goal });
        const turnInterruptSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "turnInterrupt")
            .mockResolvedValue(undefined);
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });

        controller.abort();
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });

        mockFixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: "session-id",
                turnId: "goal-turn-id",
                itemId: "goal-message-id",
                delta: "leaked goal output",
            },
        });

        await vi.waitFor(() => {
            expect(turnInterruptSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                turnId: "goal-turn-id",
            });
        });
        await flushAsyncWork();
        expect(mockFixture.getAcpConnectionDump([])).not.toContain("leaked goal output");
    });

    it('does not hang when goal set starts no continuation turn', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const goal = createThreadGoal({updatedAt: 1710000300});
        const threadGoalSetSpy = vi.spyOn(codexAppServerClient, "threadGoalSet")
            .mockResolvedValue({ goal });
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        let resultSettled = false;

        const resultPromise = codexAppServerClient.runGoalSet({
            threadId: "session-id",
            objective: "Ship the migration and keep tests green",
            status: "active",
        }, undefined, 0).finally(() => {
            resultSettled = true;
        });

        await vi.waitFor(() => {
            expect(threadGoalSetSpy).toHaveBeenCalledWith({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            });
        });
        await flushAsyncWork();
        expect(resultSettled).toBe(false);

        mockFixture.sendServerNotification({
            method: "thread/goal/updated",
            params: {
                threadId: "session-id",
                turnId: null,
                goal,
            },
        });

        await expect(resultPromise).resolves.toBeNull();
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
    });

    it('keeps goal set pending after elapsed startup time until a turn is routed', async () => {
        vi.useFakeTimers();
        try {
            const mockFixture = createCodexMockTestFixture();
            const codexAppServerClient = mockFixture.getCodexAppServerClient();
            const goal = createThreadGoal({updatedAt: 1710000400});
            vi.spyOn(codexAppServerClient, "threadGoalSet")
                .mockResolvedValue({ goal });
            const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted")
                .mockResolvedValue({
                    threadId: "session-id",
                    turn: createTurn("goal-turn-id", "completed"),
                });
            let resultSettled = false;

            const resultPromise = codexAppServerClient.runGoalSet({
                threadId: "session-id",
                objective: "Ship the migration and keep tests green",
                status: "active",
            }, undefined, undefined).finally(() => {
                resultSettled = true;
            });

            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(10_000);
            await Promise.resolve();
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification({
                method: "thread/goal/updated",
                params: {
                    threadId: "session-id",
                    turnId: null,
                    goal,
                },
            });
            await Promise.resolve();
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "session-id",
                    turnId: "goal-turn-id",
                    itemId: "goal-message-id",
                    delta: "late goal output",
                },
            });

            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(resultSettled).toBe(false);

            mockFixture.sendServerNotification(createTurnCompletedNotification("session-id", "goal-turn-id"));
            await vi.advanceTimersByTimeAsync(0);
            await expect(resultPromise).resolves.toMatchObject({
                threadId: "session-id",
                turn: {
                    id: "goal-turn-id",
                    status: "completed",
                },
            });
            expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('completes goal slash command when app server starts no continuation turn', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture();
        const goalRunSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "runGoalSet")
            .mockResolvedValue(null);

        const response = await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal Ship the migration and keep tests green" }],
        });

        expect(response.stopReason).toBe("end_turn");
        expect(goalRunSpy).toHaveBeenCalledWith({
            threadId: "session-id",
            objective: "Ship the migration and keep tests green",
            status: "active",
        }, expect.any(Function));
        expect(turnStartSpy).not.toHaveBeenCalled();
    });

    it('reports missing goal slash command input', async () => {
        const { mockFixture } = setupPromptFixture();
        const goalSetSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "threadGoalSet")
            .mockResolvedValue({ goal: createThreadGoal() });
        const goalClearSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "threadGoalClear")
            .mockResolvedValue({ cleared: true });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/goal" }],
        });

        expect(goalSetSpy).not.toHaveBeenCalled();
        expect(goalClearSpy).not.toHaveBeenCalled();
        const [event] = mockFixture.getAcpConnectionEvents([]);
        expect(event).toBeDefined();
        expect(event!.args[0].update.content.text).toBe(
            'Command "/goal" requires [<objective>|clear|pause|resume].'
        );
    });
    it('returns cancelled promptly when non-interruptible slash command startup is cancelled', async () => {
        const { mockFixture } = setupPromptFixture();
        const compactStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "threadCompactStart")
            .mockResolvedValue({});
        const controller = new AbortController();

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/compact" }],
        }, controller.signal);

        await vi.waitFor(() => {
            expect(compactStartSpy).toHaveBeenCalledWith({ threadId: "session-id" });
        });

        controller.abort();
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        mockFixture.sendServerNotification({
            method: "thread/compacted",
            params: { threadId: "session-id", turnId: "compact-turn-id" },
        });
        await flushAsyncWork();
    });

    it('reports missing review slash command input', async () => {
        const { mockFixture } = setupPromptFixture();
        const reviewStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "reviewStart")
            .mockResolvedValue(createReviewStartResponse());

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{ type: "text", text: "/review-branch" }],
        });

        expect(reviewStartSpy).not.toHaveBeenCalled();
        const [event] = mockFixture.getAcpConnectionEvents([]);
        expect(event).toBeDefined();
        expect(event!.args[0].update.content.text).toBe('Command "/review-branch" requires branch name.');
    });

    it('handles logout command', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});

        fixture.clearAcpConnectionDump();
        const prompt: acp.ContentBlock[] = [{ type: "text", text: "/logout " }];
        await codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: prompt });
        await expect(fixture.getAcpConnectionDump(["sessionId"])).toMatchFileSnapshot("data/command-logout.json");
    });

    it('clears active session auth state when logout command signs out', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const model = createTestModel();
        const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getModelProvider").mockReturnValue("openai");
        const getAccountSpy = vi.spyOn(codexAcpClient, "getAccount")
            .mockResolvedValueOnce({
                account: { type: "apiKey" },
                requiresOpenaiAuth: false,
            })
            .mockResolvedValueOnce({
                account: { type: "apiKey" },
                requiresOpenaiAuth: false,
            })
            .mockResolvedValueOnce({
                account: null,
                requiresOpenaiAuth: true,
            })
            .mockResolvedValueOnce({
                account: { type: "apiKey" },
                requiresOpenaiAuth: false,
            });
        vi.spyOn(codexAcpClient, "newSession")
            .mockResolvedValueOnce({
                sessionId: "session-1",
                currentModelId,
                models: [model],
                additionalDirectories: [],
            })
            .mockResolvedValueOnce({
                sessionId: "session-2",
                currentModelId,
                models: [model],
                additionalDirectories: [],
            });
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();
        const authenticateSpy = vi.spyOn(codexAcpClient, "authenticate").mockResolvedValue(true);

        const session1 = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});
        const session2 = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});
        expect(codexAcpAgent.getSessionState(session1.sessionId).authConfigured).toBe(true);
        expect(codexAcpAgent.getSessionState(session2.sessionId).authConfigured).toBe(true);

        await codexAcpAgent.prompt({
            sessionId: session1.sessionId,
            prompt: [{ type: "text", text: "/logout" }],
        });

        expect(logoutSpy).toHaveBeenCalledOnce();
        expect(getAccountSpy).toHaveBeenCalledTimes(3);
        expect(codexAcpAgent.getSessionState(session1.sessionId)).toMatchObject({
            account: null,
            authConfigured: false,
        });
        expect(codexAcpAgent.getSessionState(session2.sessionId)).toMatchObject({
            account: null,
            authConfigured: false,
        });

        await codexAcpAgent.authenticate({methodId: "api-key"});

        expect(authenticateSpy).toHaveBeenCalledWith({methodId: "api-key"});
        expect(getAccountSpy).toHaveBeenCalledTimes(4);
        expect(codexAcpAgent.getSessionState(session1.sessionId)).toMatchObject({
            account: { type: "apiKey" },
            authConfigured: true,
        });
        expect(codexAcpAgent.getSessionState(session2.sessionId)).toMatchObject({
            account: { type: "apiKey" },
            authConfigured: true,
        });
    });

    it('does not overwrite OpenAI session auth state when gateway auth succeeds', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const model = createTestModel();
        const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getModelProvider").mockReturnValue(null);
        const getAccountSpy = vi.spyOn(codexAcpClient, "getAccount")
            .mockResolvedValue({
                account: { type: "apiKey" },
                requiresOpenaiAuth: false,
            });
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "openai-session",
            currentModelId,
            models: [model],
            modelProvider: "openai",
            additionalDirectories: [],
        });
        const authenticateSpy = vi.spyOn(codexAcpClient, "authenticate").mockResolvedValue(true);

        const session = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});
        expect(codexAcpAgent.getSessionState(session.sessionId)).toMatchObject({
            account: { type: "apiKey" },
            authConfigured: true,
            authProvider: "openai",
        });

        const gatewayAuthRequest: CodexAuthRequest = {
            methodId: "gateway",
            _meta: {
                "gateway": {
                    baseUrl: "https://www.example.com",
                    headers: {
                        "Custom-Auth-Header": "TOKEN",
                    },
                },
            },
        };
        await codexAcpAgent.authenticate(gatewayAuthRequest);

        expect(authenticateSpy).toHaveBeenCalledWith(gatewayAuthRequest);
        expect(getAccountSpy).toHaveBeenCalledTimes(1);
        expect(codexAcpAgent.getSessionState(session.sessionId)).toMatchObject({
            account: { type: "apiKey" },
            authConfigured: true,
            authProvider: "openai",
        });
    });

    it('keeps custom provider sessions auth configured without account state', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAcpClient = mockFixture.getCodexAcpClient();
        const model = createTestModel();
        const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getModelProvider").mockReturnValue("custom-provider");
        const getAccountSpy = vi.spyOn(codexAcpClient, "getAccount")
            .mockResolvedValue({
                account: null,
                requiresOpenaiAuth: true,
            });
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "custom-provider-session",
            currentModelId,
            models: [model],
            additionalDirectories: [],
        });
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        const session = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});
        expect(codexAcpAgent.getSessionState(session.sessionId)).toMatchObject({
            account: null,
            authConfigured: true,
        });

        await codexAcpAgent.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "/logout" }],
        });

        expect(logoutSpy).toHaveBeenCalledOnce();
        expect(getAccountSpy).not.toHaveBeenCalled();
        expect(codexAcpAgent.getSessionState(session.sessionId)).toMatchObject({
            account: null,
            authConfigured: true,
        });
    });

    it('handles skills command', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        vi.spyOn(fixture.getCodexAcpClient(), "listSkills").mockResolvedValue({
            data: [{
                cwd: "/workspace",
                skills: [
                    { name: "build", description: "Build the project", shortDescription: "Build", path: "/workspace/build", scope: "user", enabled: true },
                    { name: "deploy", description: "Deploy the service", path: "/workspace/deploy", scope: "repo", enabled: true }
                ],
                errors: []
            }]
        });

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});

        fixture.clearAcpConnectionDump();
        const prompt: acp.ContentBlock[] = [{ type: "text", text: "/skills " }];
        await codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: prompt });

        await expect(fixture.getAcpConnectionDump(["sessionId"])).toMatchFileSnapshot("data/command-skills.json");
    });

    it('handles mcp command', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        vi.spyOn(fixture.getCodexAcpClient(), "listMcpServers").mockResolvedValue({
            data: [
                {
                    name: "fs",
                    serverInfo: null,
                    tools: {listFiles: {name: "listFiles", inputSchema: {type: "object"}}},
                    resources: [{name: "workspace", uri: "file:///workspace"}],
                    resourceTemplates: [],
                    authStatus: "bearerToken"
                },
                {
                    name: "browser",
                    serverInfo: null,
                    tools: {},
                    resources: [],
                    resourceTemplates: [],
                    authStatus: "notLoggedIn"
                }
            ],
            nextCursor: null
        });

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});

        fixture.clearAcpConnectionDump();
        const prompt: acp.ContentBlock[] = [{ type: "text", text: "/mcp " }];
        await codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: prompt });
        await expect(fixture.getAcpConnectionDump(["sessionId"])).toMatchFileSnapshot("data/command-mcp.json");
    });

    it('handles builtin slash command locally when prompt has attachments', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        const prompt: acp.ContentBlock[] = [
            { type: "text", text: "/status " },
            {
                type: "resource_link",
                name: "editor.xml",
                uri: "file:///editor.xml",
                description: "File that is opened in the IDE and is currently viewed by the user",
            },
        ];

        fixture.clearAcpConnectionDump();
        await codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: prompt });
        const transportDump = fixture.getAcpConnectionDump([]);
        expect(transportDump).contain(`**Session:** \`${newSessionResponse.sessionId}\``);
    });

    const mockModels: Model[] = [
        {
            id: '5.2-codex',
            model: '5.2-codex',
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: 'Codex 5.2',
            description: 'Coding model',
            hidden: false,
            supportedReasoningEfforts: [
                { reasoningEffort: 'high', description: 'Deep' },
                { reasoningEffort: 'medium', description: 'Balanced' }
            ],
            defaultReasoningEffort: 'medium',
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
            inputModalities: []
        },
        {
            id: '5.1',
            model: '5.1',
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: 'Standard 5.1',
            description: 'Standard model',
            hidden: false,
            supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Fast' }
            ],
            defaultReasoningEffort: 'low',
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
            inputModalities: []
        }
    ];

    it('should fallback to the default model when modelId is null', () => {
        const result = fixture.getCodexAcpClient().createModelId(mockModels, null, 'low');
        expect(result).toEqual(ModelId.create('5.1', 'low'));
    });

    it('should fallback to the model-specific effort when reasoningEffort is null', () => {
        const result = fixture.getCodexAcpClient().createModelId(mockModels, '5.2-codex', null);
        expect(result).toEqual(ModelId.create('5.2-codex', 'medium'));
    });

    it('should keep a model id that is not in the advertised catalog (custom provider)', () => {
        const result = fixture.getCodexAcpClient().createModelId(mockModels, 'MiniMax-M3', 'high');
        expect(result).toEqual(ModelId.create('MiniMax-M3', 'high'));
    });

    it('should default the effort for an uncatalogued model when reasoningEffort is null', () => {
        const result = fixture.getCodexAcpClient().createModelId(mockModels, 'MiniMax-M3', null);
        expect(result).toEqual(ModelId.create('MiniMax-M3', 'medium'));
    });

    /**
     * Sets up a mock fixture with turnStart/awaitTurnCompleted spied on,
     * and a given session state. Returns the fixture and turnStart spy.
     */
    function setupPromptFixture(sessionOverrides?: Partial<SessionState>) {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState(sessionOverrides);
        const turnStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({
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
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionState.sessionId,
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
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        return { mockFixture, sessionState, turnStartSpy };
    }

    function createReviewStartResponse(
        reviewThreadId: string = "session-id",
        turnId: string = "review-turn-id",
    ): ReviewStartResponse {
        return {
            reviewThreadId,
            turn: {
                id: turnId,
                items: [],
                itemsView: "notLoaded",
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            }
        };
    }

    function createReviewCompletedNotification(status: "completed" | "interrupted" = "completed"): TurnCompletedNotification {
        return {
            threadId: "session-id",
            turn: {
                id: "review-turn-id",
                items: [],
                itemsView: "notLoaded",
                status,
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            }
        };
    }

    function createThreadGoal(overrides?: Partial<ThreadGoal>): ThreadGoal {
        return {
            threadId: "session-id",
            objective: "Ship the migration and keep tests green",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1710000000,
            updatedAt: 1710000000,
            ...overrides,
        };
    }

    it ('should disable reasoning.summary if key authorization is used', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({ account: { type: "apiKey" } });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: "none" }));
    });

    it ('should enable reasoning.summary by default', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
        });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: "auto" }));
    });

    it ('should disable reasoning.summary when model lacks reasoning', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            supportedReasoningEfforts: [{ reasoningEffort: "none", description: "No reasoning" }],
        });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: "none" }));
    });

    it ('should enable reasoning.summary when model supports reasoning', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            supportedReasoningEfforts: [
                { reasoningEffort: "none", description: "No reasoning" },
                { reasoningEffort: "medium", description: "Default effort" },
            ],
        });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: "auto" }));
    });

    it ('should reject prompt with images when model does not support image input', async () => {
        const { mockFixture } = setupPromptFixture({
            supportedInputModalities: ["text"],
        });

        const prompt: acp.ContentBlock[] = [
            { type: "text", text: "Hello" },
            { type: "image", mimeType: "image/png", data: "abc123", uri: "https://example.com/image.png" },
        ];

        await expect(mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt }))
            .rejects.toThrow("Invalid request");
    });

    it ('should accept prompt with images when model supports image input', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            supportedInputModalities: ["text", "image"],
        });

        const prompt: acp.ContentBlock[] = [
            { type: "text", text: "Hello" },
            { type: "image", mimeType: "image/png", data: "abc123", uri: "https://example.com/image.png" },
        ];

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            input: [
                { type: "text", text: "Hello", text_elements: [] },
                { type: "image", url: "https://example.com/image.png" },
            ]
        }));
    });

    it ('should use inline image data for internal image URIs', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            supportedInputModalities: ["text", "image"],
        });

        const prompt: acp.ContentBlock[] = [
            { type: "text", text: "Hello" },
            { type: "image", mimeType: "image/png", data: "abc123", uri: "zed:///agent/pasted-image?name=Image" },
        ];

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            input: [
                { type: "text", text: "Hello", text_elements: [] },
                { type: "image", url: "data:image/png;base64,abc123" },
            ]
        }));
    });

    it ('should use inline image data for local file image URIs', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            supportedInputModalities: ["text", "image"],
        });

        const prompt: acp.ContentBlock[] = [
            { type: "image", mimeType: "image/png", data: "abc123", uri: "file:///Users/test/Desktop/Screenshot%201.png" },
        ];

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            input: [
                { type: "image", url: "data:image/png;base64,abc123" },
            ]
        }));
    });

    it ('should preserve data image URLs', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            supportedInputModalities: ["text", "image"],
        });

        const prompt: acp.ContentBlock[] = [
            { type: "image", mimeType: "image/png", data: "fallback", uri: "data:image/png;base64,abc123" },
        ];

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            input: [
                { type: "image", url: "data:image/png;base64,abc123" },
            ]
        }));
    });

    it ('should show rate limits from multiple sources in status', async () => {
        const rateLimits: RateLimitsMap = new Map();
        rateLimits.set("limit-1", {
            limitId: "limit-1",
            limitName: "Standard",
            snapshot: {
                limitId: "limit-1",
                limitName: "Standard",
                primary: { usedPercent: 25, resetsAt: null, windowDurationMins: 60 },
                secondary: null,
                credits: null,
                individualLimit: null,
                planType: null,
                rateLimitReachedType: null,
            }
        });
        rateLimits.set("limit-2", {
            limitId: "limit-2",
            limitName: "Fast",
            snapshot: {
                limitId: "limit-2",
                limitName: "Fast",
                primary: { usedPercent: 80, resetsAt: null, windowDurationMins: 1440 },
                secondary: null,
                credits: null,
                individualLimit: null,
                planType: null,
                rateLimitReachedType: null,
            }
        });

        const { mockFixture } = setupPromptFixture({ rateLimits });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "session-id", prompt: [{ type: "text", text: "/status" }] });
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-status-with-rate-limits.json");
    });

    it ('should surface thread/compacted as user-visible message', async () => {
        const sessionId = "test-session-id";
        const { mockFixture } = setupPromptFixture({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "thread/compacted",
            params: { threadId: sessionId, turnId: "turn-id" }
        });

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/thread-compacted.json");
    });

    it ('should surface contextCompaction item lifecycle as a tool call', async () => {
        const sessionId = "test-session-id";
        const { mockFixture } = setupPromptFixture({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-id",
                startedAtMs: 0,
                item: { type: "contextCompaction", id: "context-compaction-id" },
            },
        });
        mockFixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-id",
                completedAtMs: 0,
                item: { type: "contextCompaction", id: "context-compaction-id" },
            },
        });

        await vi.waitFor(() => {
            const events = mockFixture.getAcpConnectionEvents([]);
            expect(events).toHaveLength(2);
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/context-compaction-lifecycle.json");
    });

    it ('should surface exitedReviewMode item as user-visible review output', async () => {
        const sessionId = "test-session-id";
        const { mockFixture } = setupPromptFixture({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-id",
                completedAtMs: 0,
                item: {
                    type: "exitedReviewMode",
                    id: "review-output-id",
                    review: "No findings.",
                },
            },
        });

        await vi.waitFor(() => {
            const events = mockFixture.getAcpConnectionEvents([]);
            expect(events.length).toBeGreaterThan(0);
        });

        const [event] = mockFixture.getAcpConnectionEvents([]);
        expect(event!.args[0].update.content.text).toBe("No findings.");
    });

    it ('should accumulate rate limits from multiple notifications', async () => {
        const sessionId = "test-session-id";
        const { mockFixture, sessionState } = setupPromptFixture({ sessionId });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        mockFixture.sendServerNotification({
            method: "account/rateLimits/updated",
            params: {
                rateLimits: {
                    limitId: "standard-limit",
                    limitName: "Standard",
                    primary: { usedPercent: 30, resetsAt: null, windowDurationMins: 60 },
                    secondary: null,
                    credits: null,
                    individualLimit: null,
                    planType: null,
                    rateLimitReachedType: null,
                }
            }
        });

        mockFixture.sendServerNotification({
            method: "account/rateLimits/updated",
            params: {
                rateLimits: {
                    limitId: "fast-limit",
                    limitName: "Fast",
                    primary: { usedPercent: 50, resetsAt: null, windowDurationMins: 1440 },
                    secondary: null,
                    credits: null,
                    individualLimit: null,
                    planType: null,
                    rateLimitReachedType: null,
                }
            }
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

        expect(sessionState.rateLimits).not.toBeNull();
        expect(sessionState.rateLimits!.size).toBe(2);
        expect(sessionState.rateLimits!.get("standard-limit")).toEqual({
            limitId: "standard-limit",
            limitName: "Standard",
            snapshot: {
                limitId: "standard-limit",
                limitName: "Standard",
                primary: { usedPercent: 30, resetsAt: null, windowDurationMins: 60 },
                secondary: null,
                credits: null,
                individualLimit: null,
                planType: null,
                rateLimitReachedType: null,
            }
        });
        expect(sessionState.rateLimits!.get("fast-limit")).toEqual({
            limitId: "fast-limit",
            limitName: "Fast",
            snapshot: {
                limitId: "fast-limit",
                limitName: "Fast",
                primary: { usedPercent: 50, resetsAt: null, windowDurationMins: 1440 },
                secondary: null,
                credits: null,
                individualLimit: null,
                planType: null,
                rateLimitReachedType: null,
            }
        });
    });
});
