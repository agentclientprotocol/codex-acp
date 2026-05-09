import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture
} from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - review events", () => {
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

    it("renders entered review mode", async () => {
        const notification: ServerNotification = {
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "review-turn",
                startedAtMs: 0,
                item: {
                    type: "enteredReviewMode",
                    id: "review-turn",
                    review: "uncommitted changes",
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [notification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/review-entered.json");
    });

    it("renders exited review mode", async () => {
        const notification: ServerNotification = {
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "review-turn",
                completedAtMs: 0,
                item: {
                    type: "exitedReviewMode",
                    id: "review-turn",
                    review: "No findings.",
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [notification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/review-exited.json");
    });
});
