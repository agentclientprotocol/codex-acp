import {describe, expect, it, vi, beforeEach} from 'vitest';
import type {CodexAuthRequest} from "../../CodexAuthMethod";
import {createTestFixture, type TestFixture} from "../acp-test-utils";
import type {ServerNotification} from "../../app-server";
import type {SessionState} from "../../CodexAcpServer";

describe('ACP server test', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    beforeEach(() => {
        fixture = createTestFixture();
        vi.clearAllMocks();
    });

    const ignoredFields = ["thread", "cwd", "id", "createdAt", "path", "threadId", "userAgent", "sandbox", "reasoningEffort", "conversationId"];

    it('should start conversation', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "", mcpServers: []});
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
        function onServerNotification(callback: (event: ServerNotification) => void){
            for (const notification of serverNotifications) {
                callback(notification);
            }
        }
        return onServerNotification;
    }

    it('should map events from dump', async () => {
        fixture.getCodexAppServerClient().onServerNotification = loadNotifications();

        const codexAcpAgent = fixture.getCodexAcpAgent();

        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue(undefined);
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue(undefined);
        const sessionState: SessionState = {
            pendingPrompt: null,
            sessionMetadata: {
                sessionId: "id",
                currentModelId: "model-id",
                models: [],
            }
        };
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({ sessionId: "id", prompt: [{type: "text", text: ""}] });

        expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/output-acp-events.json");

    });

    //dev-time test
    it.skip('should convert session notification to acp events', async () => {
        fixture.onCodexConnectionEvent((event) => {
            console.log(JSON.stringify(event, null, 2));
        });
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        const newSessionResponse = await codexAcpAgent.newSession({cwd: "/home/alex/work/spring-petclinic/", mcpServers: []});
        fixture.clearCodexConnectionDump();
        await codexAcpAgent.prompt({ sessionId: newSessionResponse.sessionId, prompt: [{type: "text", text: "Add method `minus` to Math Utils."}] });
    });
});
