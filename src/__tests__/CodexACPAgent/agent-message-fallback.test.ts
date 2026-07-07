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

describe("CodexEventHandler - agent message fallback", () => {
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

    it("emits agent message text from item/completed when no deltas streamed", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "agentMessage",
                        id: "msg-1",
                        text: "Hello!",
                        phase: null,
                        memoryCitation: null,
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/agent-message-completed-fallback.json"
        );
    });

    it("does not duplicate agent message when deltas were streamed", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "msg-2",
                    delta: "Hel",
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "msg-2",
                    delta: "lo!",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "agentMessage",
                        id: "msg-2",
                        text: "Hello!",
                        phase: null,
                        memoryCitation: null,
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/agent-message-deltas-no-duplicate.json"
        );
    });
});
