import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { createCodexMockTestFixture } from "../acp-test-utils";
import type { Model, Thread } from "../../app-server/v2";

describe("CodexACPAgent - loadSession", () => {
    it("should replay history during loadSession", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.awaitMcpStartup = vi.fn().mockResolvedValue([]);
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            supportsPersonality: false,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        const thread: Thread = {
            id: "session-1",
            preview: "Hi",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 123,
            updatedAt: 124,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [
                {
                    id: "turn-1",
                    status: "completed",
                    error: null,
                    items: [
                        {
                            type: "userMessage",
                            id: "item-user-1",
                            content: [
                                { type: "text", text: "Hi", text_elements: [] },
                                { type: "image", url: "https://example.com/image.png" },
                            ],
                        },
                        {
                            type: "agentMessage",
                            id: "item-agent-1",
                            text: "Hello!",
                            phase: null,
                            memoryCitation: null,
                        },
                        {
                            type: "reasoning",
                            id: "item-reason-1",
                            summary: ["Thinking..."],
                            content: [],
                        },
                        {
                            type: "commandExecution",
                            id: "item-cmd-1",
                            command: "ls",
                            cwd: "/test/project",
                            processId: null,
                            source: "agent",
                            status: "completed",
                            commandActions: [],
                            aggregatedOutput: null,
                            exitCode: 0,
                            durationMs: 5,
                        },
                        {
                            type: "fileChange",
                            id: "item-file-1",
                            changes: [
                                {
                                    path: "/test/project/Added.txt",
                                    kind: { type: "add" },
                                    diff: `--- /dev/null
+++ /test/project/Added.txt
@@ -0,0 +1,2 @@
+Hello
+World
`,
                                },
                            ],
                            status: "completed",
                        },
                        {
                            type: "mcpToolCall",
                            id: "item-mcp-1",
                            server: "github",
                            tool: "search",
                            status: "completed",
                            arguments: {},
                            result: null,
                            error: null,
                            durationMs: null,
                        },
                        {
                            type: "dynamicToolCall",
                            id: "item-dyn-1",
                            tool: "list_apps",
                            arguments: { includeDisabled: false },
                            status: "completed",
                            contentItems: [{ type: "inputText", text: "Done" }],
                            success: true,
                            durationMs: 3,
                        },
                    ],
                },
            ],
        };

        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadParams: acp.LoadSessionRequest = {
            sessionId: thread.id,
            cwd: "/test/project",
            mcpServers: [],
        };
        await codexAcpAgent.loadSession(loadParams);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/load-session-history.json"
        );
    });

    it("should recover session mcp servers during loadSession when request omits them", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const awaitMcpStartupSpy = vi.spyOn(codexAcpClient, "awaitMcpStartup").mockResolvedValue(["persisted-mcp"]);

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: {
                id: "session-1",
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 0,
                updatedAt: 0,
                status: { type: "idle" },
                path: null,
                cwd: "/test/project",
                cliVersion: "0.0.0",
                source: "cli",
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            },
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });
        await codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [],
        });

        expect(awaitMcpStartupSpy).toHaveBeenCalledWith(0);
        expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual(["persisted-mcp"]);
    });

    it("publishes MCP startup failure for explicitly requested servers during loadSession", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: {
                id: "session-1",
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 0,
                updatedAt: 0,
                status: { type: "idle" },
                path: null,
                cwd: "/test/project",
                cliVersion: "0.0.0",
                source: "cli",
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            },
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadPromise = codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [{
                name: "broken-mcp",
                command: "npx",
                args: ["broken"],
                env: [],
            }],
        });

        await vi.waitFor(() => {
            expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual(["broken-mcp"]);
        });

        fixture.sendServerNotification({
            method: "codex/event/mcp_startup_complete",
            params: {
                msg: {
                    type: "mcp_startup_complete",
                    ready: [],
                    failed: [{
                        server: "broken-mcp",
                        error: "boom",
                    }],
                    cancelled: [],
                }
            }
        });

        await loadPromise;

        await vi.waitFor(() => {
            const dump = fixture.getAcpConnectionDump([]);
            expect(dump).toContain('"toolCallId": "mcp_startup.broken-mcp"');
            expect(dump).toContain('MCP server `broken-mcp` failed to start: boom');
        });
    });
});
