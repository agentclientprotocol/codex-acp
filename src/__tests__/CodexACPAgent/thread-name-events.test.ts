import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - thread name events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: "model-id[effort]",
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
    });

    async function setupPrompt() {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null },
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompletedForThread = vi.fn().mockResolvedValue({
            threadId: sessionId,
            turn: { id: "turn-id", items: [], status: "completed", error: null },
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "test prompt" }],
        });
        mockFixture.clearAcpConnectionDump();
    }

    it("should map thread/name/updated to session_info_update", async () => {
        await setupPrompt();

        const notification: ServerNotification = {
            method: "thread/name/updated",
            params: {
                threadId: sessionId,
                threadName: " Fix flaky CI test ",
            },
        };

        mockFixture.sendServerNotification(notification);

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/thread-name-updated.json");
    });

    it("should ignore empty thread names", async () => {
        await setupPrompt();

        mockFixture.sendServerNotification({
            method: "thread/name/updated",
            params: {
                threadId: "thread-1",
                threadName: "   ",
            },
        });

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump).toEqual("");
        });
    });

    it("should ignore thread names for other sessions", async () => {
        await setupPrompt();

        mockFixture.sendServerNotification({
            method: "thread/name/updated",
            params: {
                threadId: "different-session-id",
                threadName: "New title",
            },
        });

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump).toEqual("");
        });
    });
});
