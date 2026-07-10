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

    // Reproduce Codex part ordering and split summary markup.
    it("normalizes streamed summaries and preserves raw reasoning without duplicates", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/reasoning/summaryPartAdded",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    summaryIndex: 0,
                },
            },
            {
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    summaryIndex: 0,
                    delta: "**First thought**\n\n<!--",
                },
            },
            {
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    summaryIndex: 0,
                    delta: " -->",
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
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-1",
                    summaryIndex: 1,
                    delta: "**Second thought**\n\n<!-- -->",
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
                        summary: ["**First thought**\n\n<!-- -->", "**Second thought**\n\n<!-- -->"],
                        content: [],
                    },
                },
            },
            {
                method: "item/reasoning/textDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-raw",
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
                        id: "reasoning-raw",
                        summary: [],
                        content: ["Raw reasoning detail"],
                    },
                },
            },
            {
                method: "item/reasoning/summaryPartAdded",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-empty",
                    summaryIndex: 0,
                },
            },
            {
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "reasoning-empty",
                    summaryIndex: 0,
                    delta: "\n\n<!-- -->",
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
                        id: "reasoning-empty",
                        summary: ["\n\n<!-- -->"],
                        content: [],
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
