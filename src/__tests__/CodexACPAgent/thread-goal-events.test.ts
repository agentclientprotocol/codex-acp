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

describe("CodexEventHandler - thread goal events", () => {
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

    it("should send thread goal updates as agent messages", async () => {
        const goalUpdatedNotification: ServerNotification = {
            method: "thread/goal/updated",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                goal: {
                    threadId: sessionId,
                    objective: "Ship the goal update",
                    status: "active",
                    tokenBudget: null,
                    tokensUsed: 42,
                    timeUsedSeconds: 12,
                    createdAt: 1710000000,
                    updatedAt: 1710000012,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [goalUpdatedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/thread-goal-updated.json"
        );
    });

    it("should format multiline thread goal updates", async () => {
        const goalUpdatedNotification: ServerNotification = {
            method: "thread/goal/updated",
            params: {
                threadId: sessionId,
                turnId: null,
                goal: {
                    threadId: sessionId,
                    objective: "  First task\nSecond task\n  ",
                    status: "budgetLimited",
                    tokenBudget: 1000,
                    tokensUsed: 1000,
                    timeUsedSeconds: 30,
                    createdAt: 1710000000,
                    updatedAt: 1710000030,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [goalUpdatedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/thread-goal-updated-multiline.json"
        );
    });

    it("should send thread goal cleared as an agent message", async () => {
        const goalClearedNotification: ServerNotification = {
            method: "thread/goal/cleared",
            params: {
                threadId: sessionId,
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [goalClearedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/thread-goal-cleared.json"
        );
    });
});
