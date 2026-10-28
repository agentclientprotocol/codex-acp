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

    it("renders streamed Codex file citations as Markdown file links", async () => {
        const delta = (text: string): ServerNotification => ({
            method: "item/agentMessage/delta",
            params: {threadId: sessionId, turnId: "turn-1", itemId: "final-message", delta: text},
        });
        const notifications: ServerNotification[] = [
            delta("The minimum length is 12.\n\n:codex-file"),
            delta("-citation{path=\"docs/policy.txt\" pur"),
            delta("pose=\"source\"} and "),
            delta(":codex-file-citation{path=\"/abs/notes.md:4\"}"),
            delta(". Literal `:codex-file-citation{path=\"x\"}` stays; an unfinished one is sent at the end: :codex-fi"),
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 10,
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
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/agent-message-file-citations.json"
        );
    });
});
