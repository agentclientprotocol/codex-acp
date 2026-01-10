// noinspection ES6RedundantAwait

import {describe, expect, it, vi, beforeEach} from 'vitest';
import type {CodexAuthRequest} from "../../CodexAuthMethod";
import type * as acp from "@agentclientprotocol/sdk";
import {createTestFixture, createCodexMockTestFixture, type TestFixture} from "../acp-test-utils";
import type {ServerNotification} from "../../app-server";
import type {SessionState} from "../../CodexAcpServer";
import {AgentMode} from "../../AgentMode";
import type {ListMcpServerStatusResponse, SkillsListResponse} from "../../app-server/v2";

describe('ACP server test', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
    });

    const ignoredFields = ["thread", "cwd", "id", "createdAt", "path", "threadId", "userAgent", "sandbox",  "conversationId", "origins", "projects", "supportedReasoningEfforts", "reasoningEffort", "model"];

    it('should start conversation', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        // noinspection ES6MissingAwait - we're only check initialization
        codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: [{type: "text", text: "Hi!"}]});

        const transportDump = fixture.getCodexConnectionDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/start-conversation.json");
    });

    it('should throw error without authentication', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await fixture.getCodexAcpClient().logout();
        fixture.clearCodexConnectionDump();

        await expect(
            codexAcpAgent.newSession({cwd: "", mcpServers: []})
        ).rejects.toThrow("Authentication required");

        const transportDump = fixture.getCodexConnectionDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/auth-failed.json");
    });

    it('should authenticate with key', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await fixture.getCodexAcpClient().logout();
        fixture.clearCodexConnectionDump();

        const authRequest: CodexAuthRequest = { methodId: "api-key", _meta: {apiKey: "TOKEN"} }
        await codexAcpAgent.authenticate(authRequest);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        expect(newSessionResponse.sessionId).toBeDefined()

        const transportDump = fixture.getCodexConnectionDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/auth-with-key.json");
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

    it('should map events from dump', async () => {
        fixture.getCodexAppServerClient().onServerNotification = loadNotifications();

        const codexAcpAgent = fixture.getCodexAcpAgent();

        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: "id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });
        const sessionState: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: ""}] });

        expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/output-acp-events.json");

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

        const sessionState: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        // First prompt - registers first notification handler
        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: "First message"}] });

        // Follow-up prompt - should NOT accumulate handlers
        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: "Follow-up message"}] });

        mockFixture.clearAcpConnectionDump();

        // Trigger notifications after both prompts - should produce only 3 events, not 6
        const serverNotifications: ServerNotification[] = [
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "He", }},
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "ll", }},
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "o!", }},
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
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: "id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });

        const sessionState1: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "session-1",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };
        const sessionState2: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "session-2",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };

        vi.spyOn(codexAcpAgent, "getSessionState").mockImplementation((sessionId: string) => {
            return sessionId === "session-1" ? sessionState1 : sessionState2;
        });

        // Start prompts for two different sessions
        await codexAcpAgent.prompt({ sessionId: "session-1", prompt: [{type: "text", text: "Message to session 1"}] });
        await codexAcpAgent.prompt({ sessionId: "session-2", prompt: [{type: "text", text: "Message to session 2"}] });

        mockFixture.clearAcpConnectionDump();

        // Trigger notifications - both session handlers should receive them
        const serverNotifications: ServerNotification[] = [
            { method: "item/agentMessage/delta", params: { threadId: "string", turnId: "string", itemId: "string", delta: "Hello", }},
        ];
        for (const notification of serverNotifications) {
            mockFixture.sendServerNotification(notification);
        }

        // Wait for async handlers to complete
        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });

        // Should have 2 events - one for each session's handler
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/multiple-sessions.json");
    });

    it('should send attachments as prompt items', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: "session-id",
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });

        const sessionState: SessionState = {
            currentTurnId: null,
            sessionMetadata: {
                sessionId: "session-id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE,
            },
            lastTokenUsage: null
        };
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

    async function createSessionInSeparateInstance(): Promise<string> {
        const initFixture = createTestFixture();
        initFixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        await initFixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        const newSessionResponse = await initFixture.getCodexAcpAgent().newSession({
            cwd: "",
            mcpServers: []
        });
        return newSessionResponse.sessionId;
    }

    it('should resume session', async () => {
        const sessionId = await createSessionInSeparateInstance();

        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        fixture.clearCodexConnectionDump();

        await fixture.getCodexAcpAgent().unstable_resumeSession({
            cwd: "",
            sessionId: sessionId
        });
        await expect(fixture.getCodexConnectionDump(ignoredFields.concat("data", "model"))).toMatchFileSnapshot("data/thread-resume.json");

        const promptResult: Promise<acp.PromptResponse> = fixture.getCodexAcpAgent().prompt({
            sessionId: sessionId,
            prompt: []
        });

        expect(promptResult).toBeDefined();
    });

    it('should fail on wrong sessionId', async () => {
        const sessionId = "not-existing-session";

        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        fixture.clearCodexConnectionDump();

        await expect(
            fixture.getCodexAcpAgent().unstable_resumeSession({cwd: "", sessionId: sessionId})
        ).rejects.toThrow("invalid thread id");
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
                    scope: "user"
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

        const sessionState: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "session-id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({ sessionId: "session-id", prompt: [{ type: "text", text: "/status" }] });
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-status.json");
    });

    it('handles logout command', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const sessionState: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "session-id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };

        const logoutSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "logout").mockResolvedValue(undefined);

        // @ts-expect-error - exercising private helper
        const handled = await codexAcpAgent.availableCommands.handleCommand({ name: "logout", input: null }, sessionState);

        expect(handled).toBe(true);
        expect(logoutSpy).toHaveBeenCalledTimes(1);
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-logout.json");
    });

    it('handles skills command', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const sessionState: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "session-id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };

        const skillsResponse: SkillsListResponse = {
            data: [{
                cwd: "/workspace",
                skills: [
                    { name: "build", description: "Build the project", shortDescription: "Build", path: "/workspace/build", scope: "user" },
                    { name: "deploy", description: "Deploy the service", path: "/workspace/deploy", scope: "repo" }
                ],
                errors: []
            }]
        };
        const skillsSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "listSkills").mockResolvedValue(skillsResponse);

        // @ts-expect-error - exercising private helper
        const handled = await codexAcpAgent.availableCommands.handleCommand({ name: "skills", input: null }, sessionState);

        expect(handled).toBe(true);
        expect(skillsSpy).toHaveBeenCalledTimes(1);
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-skills.json");
    });

    it('handles mcp command', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const sessionState: SessionState = {
            currentTurnId: null,
            lastTokenUsage: null,
            sessionMetadata: {
                sessionId: "session-id",
                currentModelId: "model-id",
                models: [],
                agentMode: AgentMode.DEFAULT_AGENT_MODE
            }
        };

        const mcpResponse: ListMcpServerStatusResponse = {
            data: [
                {
                    name: "fs",
                    tools: { listFiles: { name: "listFiles", inputSchema: { type: "object" } } },
                    resources: [{ name: "workspace", uri: "file:///workspace" }],
                    resourceTemplates: [],
                    authStatus: "bearerToken"
                },
                {
                    name: "browser",
                    tools: {},
                    resources: [],
                    resourceTemplates: [],
                    authStatus: "notLoggedIn"
                }
            ],
            nextCursor: null
        };
        const mcpSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "listMcpServers").mockResolvedValue(mcpResponse);

        // @ts-expect-error - exercising private helper
        const handled = await codexAcpAgent.availableCommands.handleCommand({ name: "mcp", input: null }, sessionState);

        expect(handled).toBe(true);
        expect(mcpSpy).toHaveBeenCalledTimes(1);
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-mcp.json");
    });
});
