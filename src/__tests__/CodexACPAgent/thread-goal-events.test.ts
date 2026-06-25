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

        await setupPromptAndSendNotifications(mockFixture, sessionId, createSessionState(), [goalUpdatedNotification]);

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

        await setupPromptAndSendNotifications(mockFixture, sessionId, createSessionState(), [goalUpdatedNotification]);

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

        await setupPromptAndSendNotifications(mockFixture, sessionId, createSessionState(), [goalClearedNotification]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/thread-goal-cleared.json"
        );
    });

    it("should suppress duplicate thread goal updates", async () => {
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
        const duplicateGoalUpdatedNotification: ServerNotification = {
            method: "thread/goal/updated",
            params: {
                ...goalUpdatedNotification.params,
                goal: {
                    ...goalUpdatedNotification.params.goal,
                    tokensUsed: 84,
                    timeUsedSeconds: 24,
                    updatedAt: 1710000024,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, createSessionState(), [
            goalUpdatedNotification,
            duplicateGoalUpdatedNotification,
        ]);

        const events = mockFixture.getAcpConnectionEvents([]);
        expect(events).toHaveLength(1);
        expect(events[0]!.args[0].update.content.text).toBe("Goal updated (active): Ship the goal update");
    });

    it("should suppress duplicate thread goal cleared notifications", async () => {
        const goalClearedNotification: ServerNotification = {
            method: "thread/goal/cleared",
            params: {
                threadId: sessionId,
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, createSessionState(), [
            goalClearedNotification,
            goalClearedNotification,
        ]);

        const events = mockFixture.getAcpConnectionEvents([]);
        expect(events).toHaveLength(1);
        expect(events[0]!.args[0].update.content.text).toBe("Goal cleared.");
    });

    function createSessionState(): SessionState {
        return createTestSessionState({
            sessionId,
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
        });
    }
});
