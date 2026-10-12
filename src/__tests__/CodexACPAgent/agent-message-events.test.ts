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

describe("CodexEventHandler - agent message events", () => {
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

    it("includes Codex message phase metadata on streamed agent message chunks", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "agentMessage",
                        id: "commentary-message",
                        text: "",
                        phase: "commentary",
                        memoryCitation: null,
                        delivery: null,
                        questions: null,
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "commentary-message",
                    delta: "Checking the relevant event mapping.",
                },
            },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 10,
                    item: {
                        type: "agentMessage",
                        id: "final-message",
                        text: "",
                        phase: "final_answer",
                        memoryCitation: null,
                        delivery: null,
                        questions: null,
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "final-message",
                    delta: "Yes, here is the answer.",
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/agent-message-phases.json"
        );
    });
    it("delivers textless async questions with a visible fallback and structured metadata", async () => {
        const notifications: ServerNotification[] = [{
            method: "item/completed",
            params: {
                threadId: sessionId, turnId: "turn-1", completedAtMs: 1,
                item: {
                    type: "agentMessage", id: "async-question", text: "", phase: "commentary",
                    memoryCitation: null, delivery: null,
                    questions: [{ title: "Proceed with the bounded test?", options: ["Approve", "Keep paused"] }],
                },
            },
        }];
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);
        const events = mockFixture.getAcpConnectionEvents([]);
        expect(JSON.stringify(events)).toContain("Proceed with the bounded test?");
        expect(JSON.stringify(events)).toContain("codex/asyncUserInput");
        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/async-user-input.json");
    });

});
