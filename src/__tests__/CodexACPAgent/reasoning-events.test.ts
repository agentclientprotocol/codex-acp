import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import type { SessionState } from "../../CodexAcpServer";
import { AgentMode } from "../../AgentMode";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture
} from "../acp-test-utils";

describe("CodexEventHandler - reasoning events", () => {
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

    it("streams reasoning deltas and section breaks without duplicating the completed item", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    summaryIndex: 0,
                    delta: "First thought",
                },
            },
            {
                method: "item/reasoning/summaryPartAdded",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    summaryIndex: 1,
                },
            },
            {
                method: "item/reasoning/textDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    contentIndex: 0,
                    delta: "Raw reasoning detail",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "reasoning",
                        id: "reasoning-1",
                        summary: ["Completed summary should not duplicate"],
                        content: ["Completed content should not duplicate"],
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/reasoning-deltas-and-section-break.json"
        );
    });

    it("emits all completed reasoning parts when no deltas streamed", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "reasoning",
                        id: "reasoning-2",
                        summary: ["First summary", "Second summary"],
                        content: ["Raw content fallback"],
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/reasoning-completed-parts.json"
        );
    });
});
