// noinspection ES6RedundantAwait

import {describe, expect, it, vi, beforeEach} from 'vitest';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {CodexAuthRequest} from "../../CodexAuthMethod";
import type * as acp from "@agentclientprotocol/sdk";
import {createTestFixture, createCodexMockTestFixture, createTestSessionState, type TestFixture} from "../acp-test-utils";
import type {ServerNotification} from "../../app-server";
import type {SessionState} from "../../CodexAcpServer";
import {AgentMode} from "../../AgentMode";
import type {ListMcpServerStatusResponse, Model, SkillsListResponse} from "../../app-server/v2";
import type {RateLimitsMap} from "../../RateLimitsMap";
import {ModelId} from "../../ModelId";

const CODEX_HOME_ENV = "CODEX_HOME";

async function overrideCodexHome<T>(configToml: string, run: () => Promise<T>): Promise<T> {
    const previousCodexHome = process.env[CODEX_HOME_ENV];
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-codex-home-"));
    fs.writeFileSync(path.join(codexHome, "config.toml"), configToml, "utf8");
    process.env[CODEX_HOME_ENV] = codexHome;

    try {
        return await run();
    } finally {
        if (previousCodexHome === undefined) {
            delete process.env[CODEX_HOME_ENV];
        } else {
            process.env[CODEX_HOME_ENV] = previousCodexHome;
        }
        fs.rmSync(codexHome, { recursive: true, force: true });
    }
}

describe('ACP server test', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
    });

    const ignoredFields = ["thread", "cwd", "id", "createdAt", "path", "threadId", "userAgent", "sandbox",  "conversationId", "origins", "supportedReasoningEfforts", "reasoningEffort", "model", "readOnlyAccess"];

    it.skip('should start conversation', async () => {
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
        await overrideCodexHome('cli_auth_credentials_store = "file"', async () => {
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
    });

    it('should authenticate with key', async () => {
        // In sandboxed environments Codex may fail when trying to write to the OS keychain (`Operation not permitted`).
        await overrideCodexHome('cli_auth_credentials_store = "file"', async () => {
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

            const transportDump = keyFixture.getCodexConnectionDump([...ignoredFields, "upgrade"]);
            await expect(transportDump).toMatchFileSnapshot("data/auth-with-key.json");

            const authenticatedResponse = await keyFixture.getCodexAcpAgent().extMethod("authentication/status", {});
            expect(authenticatedResponse).toEqual({type: "api-key"});

            await keyFixture.getCodexAcpAgent().extMethod("authentication/logout", {});
            const logoutResponse = await keyFixture.getCodexAcpAgent().extMethod("authentication/status", {});
            expect(logoutResponse).toEqual({type: "unauthenticated"});
        });
    });

    it('should authenticate with a gateway', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await fixture.getCodexAcpClient().logout();

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
        expect(await fixture.getCodexAcpClient().authRequired()).toBe(false);

        const authenticatedResponse = await fixture.getCodexAcpAgent().extMethod("authentication/status", {});
        expect(authenticatedResponse).toEqual({type: "gateway", name: "custom-gateway"});

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        expect(newSessionResponse.sessionId).toBeDefined()
    })

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
            perCwdExtraUserRoots: [{
                cwd: "/workspace",
                extraUserRoots: ["/skills/one", "/skills/two"]
            }]
        });
        expect(listSkillsSpy.mock.invocationCallOrder[0]!).toBeLessThan(threadStartSpy.mock.invocationCallOrder[0]!);
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
            perCwdExtraUserRoots: [{
                cwd: "/workspace",
                extraUserRoots: ["/skills/one", "/skills/two"]
            }]
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

    async function createSessionInSeparateInstance(): Promise<string> {
        const initFixture = createTestFixture();
        initFixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        await initFixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        const newSessionResponse = await initFixture.getCodexAcpAgent().newSession({
            cwd: "",
            mcpServers: []
        });
        try {
            await initFixture.getCodexAcpAgent().prompt({
                sessionId: newSessionResponse.sessionId,
                prompt: [{type: "text", text: "Hi!"}]
            });
        } catch (e) {}

        return newSessionResponse.sessionId;
    }

    // too long, requires auth
    it.skip('should resume session', async () => {
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

    it('handles logout command', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const sessionState: SessionState = createTestSessionState();

        const logoutSpy = vi.spyOn(mockFixture.getCodexAcpClient(), "logout").mockResolvedValue({});

        // @ts-expect-error - exercising private helper
        const handled = await codexAcpAgent.availableCommands.handleCommand({ name: "logout", input: null }, sessionState);

        expect(handled).toBe(true);
        expect(logoutSpy).toHaveBeenCalledTimes(1);
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/command-logout.json");
    });

    it('handles skills command', async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        const sessionState: SessionState = createTestSessionState();

        const skillsResponse: SkillsListResponse = {
            data: [{
                cwd: "/workspace",
                skills: [
                    { name: "build", description: "Build the project", shortDescription: "Build", path: "/workspace/build", scope: "user", enabled: true },
                    { name: "deploy", description: "Deploy the service", path: "/workspace/deploy", scope: "repo", enabled: true }
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

        const sessionState: SessionState = createTestSessionState();

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
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        return { mockFixture, sessionState, turnStartSpy };
    }

    it ('should disable resasoning.summary if key authorization is used', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({ account: { type: "apiKey" } });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: "none" }));
    });

    it ('should not disable resasoning.summary by default', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
        });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: null }));
    });

    it ('should disable reasoning.summary when model lacks reasoning', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            supportedReasoningEfforts: [{ reasoningEffort: "none", description: "No reasoning" }],
        });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: "none" }));
    });

    it ('should not disable reasoning.summary when model supports reasoning', async () => {
        const { mockFixture, turnStartSpy } = setupPromptFixture({
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            supportedReasoningEfforts: [
                { reasoningEffort: "none", description: "No reasoning" },
                { reasoningEffort: "medium", description: "Default effort" },
            ],
        });

        await mockFixture.getCodexAcpAgent().prompt({ sessionId: "id", prompt: [{ type: "text", text: "test" }] });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({ summary: null }));
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
                planType: null,
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
                planType: null,
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
                    planType: null,
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
                    planType: null,
                }
            }
        });

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
                planType: null,
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
                planType: null,
            }
        });
    });
});
