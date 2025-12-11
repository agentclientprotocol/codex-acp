import {describe, expect, it, vi, beforeEach} from 'vitest';
import type {CodexAuthRequest} from "../../CodexAuthMethod";
import {createTestFixture, type TestFixture} from "../acp-test-utils";

describe('ACP server test', () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
    });

    const ignoredFields = ["thread", "cwd", "id", "createdAt", "path", "threadId", "userAgent"];

    it('should start conversation', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        codexAcpAgent.prompt({ sessionId: newSessionResponse.sessionId, prompt: [{type: "text", text: "Hi!"}] });

        const transportDump = fixture.getTransportDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/start-conversation.json");
    });

    it('should throw error without authentication', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await fixture.getCodexAcpClient().logout();
        fixture.clearTransportDump();

        await expect(
            codexAcpAgent.newSession({cwd: "", mcpServers: []})
        ).rejects.toThrow("Authentication required");

        const transportDump = fixture.getTransportDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/auth-failed.json");
    });

    it('should authenticate with key', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        await codexAcpAgent.initialize({protocolVersion: 1});
        await fixture.getCodexAcpClient().logout();
        fixture.clearTransportDump();

        const authRequest: CodexAuthRequest = { methodId: "api-key", _meta: {apiKey: "TOKEN"} }
        await codexAcpAgent.authenticate(authRequest);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
        expect(newSessionResponse.sessionId).toBeDefined()

        const transportDump = fixture.getTransportDump(ignoredFields);
        await expect(transportDump).toMatchFileSnapshot("data/auth-with-key.json");
    });
});
