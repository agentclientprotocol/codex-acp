// noinspection ES6RedundantAwait

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {CodexAuthRequest} from "../../CodexAuthMethod";
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
import type {Model, ReviewStartResponse, TurnCompletedNotification, TurnStartParams} from "../../app-server/v2";
import type {RateLimitsMap} from "../../RateLimitsMap";
import {ModelId} from "../../ModelId";

describe('ACP server test', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
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

        const authRequest: CodexAuthRequest = { methodId: "api-key", _meta: { "api-key": { apiKey: "TOKEN" }}}
        await codexAcpAgent.authenticate(authRequest);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        expect(newSessionResponse.sessionId).toBeDefined()

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
        expect(newSessionResponse.sessionId).toBeDefined()
    })

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
            cwds: ["/workspace"],
            forceReload: true,
        });
        expect(listSkillsSpy.mock.invocationCallOrder[0]!).toBeLessThan(threadStartSpy.mock.invocationCallOrder[0]!);
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

    it('prefetches session additional skill roots before turn start', async () => {
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
            _meta: {
                additionalRoots: ["/skills/one", " /skills/two ", 7]
            }
        };
        await codexAcpAgent.prompt(promptRequest);

        expect(listSkillsSpy).toHaveBeenCalledWith({
            cwds: ["/workspace"],
            forceReload: true,
        });
        expect(listSkillsSpy.mock.invocationCallOrder[0]!).toBeLessThan(turnStartSpy.mock.invocationCallOrder[0]!);
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

    function createTurn(id: string, status: "inProgress" | "completed") {
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
        await codexAcpAgent.availableCommands.publish("session-id");

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
        await codexAcpAgent.availableCommands.publish("session-id");

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

    function createReviewStartResponse(): ReviewStartResponse {
        return {
            reviewThreadId: "session-id",
            turn: {
                id: "review-turn-id",
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

    it ('should surface contextCompaction item as user-visible message', async () => {
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
                item: { type: "contextCompaction", id: "context-compaction-id" },
            },
        });

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/thread-compacted.json");
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
