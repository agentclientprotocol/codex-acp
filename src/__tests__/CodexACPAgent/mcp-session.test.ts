// noinspection ES6RedundantAwait

import {describe, expect, it, vi, beforeEach} from 'vitest';
import {createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture} from "../acp-test-utils";

describe('MCP session configuration', { timeout: 40_000 }, () => {

    let fixture: CodexMockTestFixture;
    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });


    it('should return configured mcp', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const sessionState = createTestSessionState({
            sessionId: "session-id",
            sessionMcpServers: ["test-mcp"],
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        vi.spyOn(fixture.getCodexAcpClient(), "listMcpServers").mockResolvedValue({
            data: [],
            nextCursor: null,
        });

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "/mcp"}]});
        const transportDump = fixture.getAcpConnectionDump([]);
        expect(transportDump).contain("Configured MCP servers:");
        expect(transportDump).contain("- test-mcp");
    });

});
