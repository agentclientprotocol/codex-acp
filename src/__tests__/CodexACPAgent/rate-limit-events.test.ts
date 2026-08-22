import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { AgentMode } from "../../AgentMode";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("CodexEventHandler - account rate limit events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const rateLimitsUpdatedNotification: ServerNotification = {
        method: "account/rateLimits/updated",
        params: {
            rateLimits: {
                limitId: "codex",
                limitName: null,
                primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1710000000 },
                secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1710600000 },
                credits: null,
                individualLimit: null,
                spendControlReached: false,
                planType: "plus",
                rateLimitReachedType: null,
            },
        },
    };

    it("should send account rate limits as session metadata", async () => {
        await setupPromptAndSendNotifications(mockFixture, sessionId, createSessionState(), [
            rateLimitsUpdatedNotification,
        ]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/account-rate-limits-updated.json"
        );
    });

    function createSessionState(): SessionState {
        return createTestSessionState({
            sessionId,
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
        });
    }
});
