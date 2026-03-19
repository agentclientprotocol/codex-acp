// noinspection ES6RedundantAwait

import {describe, expect, it, vi, beforeEach} from 'vitest';
import {createTestFixture, type TestFixture} from "../acp-test-utils";
import type {McpServerStdio} from "@agentclientprotocol/sdk";

describe('MCP session configuration', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
    });


    it('should return configured mcp', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        await codexAcpAgent.initialize({protocolVersion: 1});

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "awaitMcpServers").mockResolvedValue(["test-mcp"]);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({ data: [] });
        vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
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
        vi.spyOn(codexAppServerClient, "accountRead").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false
        });
        vi.spyOn(codexAppServerClient, "listMcpServerStatus").mockResolvedValue({
            data: [],
            nextCursor: null
        });

        const mcpServer: McpServerStdio = {
            name: "test-mcp", command: "./node_modules/.bin/mcp-hello-world", args: ["example"], env: [{name:"example", value: "example"}]
        };

        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: [mcpServer]});
        fixture.clearAcpConnectionDump();
        await codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: [{type: "text", text: "/mcp"}]});
        const transportDump = fixture.getAcpConnectionDump([]);
        expect(transportDump).contain("Configured MCP servers:\\n- test-mcp");
    });

});
