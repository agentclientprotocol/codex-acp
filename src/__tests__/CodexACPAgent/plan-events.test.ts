import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import {AgentMode} from "../../AgentMode";
import type {SessionState} from "../../CodexAcpServer";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("CodexEventHandler - plan events", () => {
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

    it("emits the authoritative completed plan after buffering deltas", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-1",
                        text: "",
                    },
                },
            },
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-1",
                    delta: "### Implementation plan\n\n",
                },
            },
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-1",
                    delta: "1. Add the event mapping.\n2. Verify it.",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-1",
                        text: "Completed text should not duplicate the streamed plan.",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-deltas.json",
        );
    });

    it("falls back to buffered deltas when the completed plan is empty", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-2",
                    delta: "### Buffered plan\n\n",
                },
            },
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-2",
                    delta: "1. Use the buffered fallback.",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-2",
                        text: "",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-delta-fallback.json",
        );
    });

    it("emits the completed plan when no deltas streamed", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-2",
                        text: "### Fallback plan\n\n1. Use the completed item.",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-completed-fallback.json",
        );
    });

    it("keeps turn plan updates as ACP checklist updates", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "turn/plan/updated",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    explanation: "Implement and verify the mapping.",
                    plan: [
                        {
                            step: "Add the event mapping",
                            status: "completed",
                        },
                        {
                            step: "Verify it in Zed",
                            status: "inProgress",
                        },
                    ],
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-checklist-update.json",
        );
    });
});
