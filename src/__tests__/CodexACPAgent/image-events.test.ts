import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - image events", () => {
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

    it("maps image generation start and completion as an image tool call flow", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "imageGeneration",
                        id: "image-generation-1",
                        status: "generating",
                        revisedPrompt: null,
                        result: "",
                    },
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "imageGeneration",
                        id: "image-generation-1",
                        status: "generating",
                        revisedPrompt: "A tiny blue square",
                        result: "iVBORw0KGgo=",
                        savedPath: "/tmp/codex/generated-blue-square.png",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/image-generation-flow.json"
        );
    });

    it("maps completed-only image generation as a full completed tool call", async () => {
        const completed: ServerNotification = {
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                completedAtMs: 0,
                item: {
                    type: "imageGeneration",
                    id: "image-generation-completed-only",
                    status: "generating",
                    revisedPrompt: null,
                    result: "iVBORw0KGgo=",
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [completed]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/image-generation-completed-only.json"
        );
    });

    it("maps view-image start and completion as one completed read tool call", async () => {
        const item = {
            type: "imageView" as const,
            id: "view-image-1",
            path: "/tmp/codex/input.png",
        };
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item,
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item,
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/view-image-flow.json"
        );
    });
});
