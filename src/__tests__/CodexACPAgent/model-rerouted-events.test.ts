import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from "../acp-test-utils";
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

    it("maps model reroute to agent thought chunk", async () => {
        const modelReroutedNotification: ServerNotification = {
            method: "model/rerouted",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                fromModel: "gpt-5",
                toModel: "gpt-5-mini",
                reason: "highRiskCyberActivity",
            }
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [modelReroutedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/model-rerouted.json"
        );
    });
});
