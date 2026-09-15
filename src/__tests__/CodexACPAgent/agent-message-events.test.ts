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

    it("publishes async user input metadata once without repeating streamed question text", async () => {
        const question = {
            type: "agentMessage" as const,
            id: "async-question-streamed",
            text: "Choose a lane\n- Stable\n- Preview",
            phase: "final_answer" as const,
            memoryCitation: null,
            delivery: "async" as const,
            questions: [{title: "Choose a lane", options: ["Stable", "Preview"]}],
        };
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {threadId: sessionId, turnId: "turn-async", startedAtMs: 1, item: question},
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-async",
                    itemId: question.id,
                    delta: question.text,
                },
            },
            {
                method: "item/completed",
                params: {threadId: sessionId, turnId: "turn-async", completedAtMs: 2, item: question},
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        expect(mockFixture.getAcpConnectionEvents([]).filter(event => event.method === "sessionUpdate"))
            .toEqual([
                {
                    method: "sessionUpdate",
                    args: [{
                        sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: question.id,
                            content: {type: "text", text: question.text},
                            _meta: {codex: {phase: "final_answer"}},
                        },
                    }],
                },
                {
                    method: "sessionUpdate",
                    args: [{
                        sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: question.id,
                            content: {type: "text", text: ""},
                            _meta: {
                                codex: {
                                    phase: "final_answer",
                                    asyncUserInput: {
                                        delivery: "async",
                                        threadId: sessionId,
                                        turnId: "turn-async",
                                        itemId: question.id,
                                        questions: [{title: "Choose a lane", options: ["Stable", "Preview"]}],
                                    },
                                },
                            },
                        },
                    }],
                },
            ]);
    });

    it("publishes a question-only completed async item when no text delta arrived", async () => {
        const question = {
            type: "agentMessage" as const,
            id: "async-question-completed-only",
            text: "What should change?",
            phase: "final_answer" as const,
            memoryCitation: null,
            delivery: "async" as const,
            questions: [{title: "What should change?", options: null}],
        };
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "item/started",
                params: {threadId: sessionId, turnId: "turn-completed-only", startedAtMs: 2, item: question},
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-completed-only",
                    completedAtMs: 3,
                    item: question,
                },
            },
        ]);

        expect(mockFixture.getAcpConnectionEvents([]).filter(event => event.method === "sessionUpdate"))
            .toEqual([{
                method: "sessionUpdate",
                args: [{
                    sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: question.id,
                        content: {type: "text", text: "What should change?"},
                        _meta: {
                            codex: {
                                phase: "final_answer",
                                asyncUserInput: {
                                    delivery: "async",
                                    threadId: sessionId,
                                    turnId: "turn-completed-only",
                                    itemId: question.id,
                                    questions: [{title: "What should change?", options: null}],
                                },
                            },
                        },
                    },
                }],
            }]);
    });
});
