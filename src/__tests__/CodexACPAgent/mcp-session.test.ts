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
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
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
