import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - model rerouted events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: "model-id[effort]",
        agentMode: AgentMode.DEFAULT_AGENT_MODE
    });

    async function setupAndSendNotifications(notifications: ServerNotification[]) {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: sessionId,
            turn: { id: "turn-id", items: [], status: "completed", error: null }
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "test prompt" }],
        });

        mockFixture.clearAcpConnectionDump();

        for (const notification of notifications) {
            mockFixture.sendServerNotification(notification);
        }

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });
    }

    it("maps model reroute to agent thought chunk", async () => {
        const modelReroutedNotification: ServerNotification = {
            method: "model/rerouted",
            params: {
                threadId: "thread-1",
                turnId: "turn-1",
                fromModel: "gpt-5",
                toModel: "gpt-5-mini",
                reason: "highRiskCyberActivity",
            }
        };

        await setupAndSendNotifications([modelReroutedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/model-rerouted.json"
        );
    });
});
