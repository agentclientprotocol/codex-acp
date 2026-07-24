import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";
import {
    createImageGenerationCompleteUpdate,
    createImageGenerationUpdate,
} from "../../CodexToolCallMapper";
import type { ThreadItem } from "../../app-server/v2";

describe("image generation updates", () => {
    const imageGenerationItem = (
        overrides: Partial<ThreadItem & { type: "imageGeneration" }> = {},
    ): ThreadItem & { type: "imageGeneration" } => ({
        type: "imageGeneration",
        id: "image-generation-1",
        status: "completed",
        revisedPrompt: null,
        result: "iVBORw0KGgo=",
        savedPath: "/tmp/codex/generated-blue-square.png",
        ...overrides,
    });

    it.each([
        ["completion", createImageGenerationCompleteUpdate],
        ["completed-only/replay", createImageGenerationUpdate],
    ])("maps the canonical saved path to matching image URI and locations for %s", (_, createUpdate) => {
        const update = createUpdate(imageGenerationItem()) as Extract<
            ReturnType<typeof createImageGenerationUpdate>,
            { sessionUpdate: "tool_call" | "tool_call_update" }
        >;

        expect(update).toMatchObject({
            status: "completed",
            locations: [{ path: "/tmp/codex/generated-blue-square.png" }],
            content: [{
                type: "content",
                content: {
                    type: "image",
                    uri: "/tmp/codex/generated-blue-square.png",
                },
            }],
        });
    });

    it.each([
        ["missing", undefined],
        ["empty", ""],
        ["whitespace-only", "   "],
    ])("omits locations and the image URI when savedPath is %s", (_, savedPath) => {
        const item = imageGenerationItem();
        if (savedPath === undefined) {
            delete item.savedPath;
        } else {
            item.savedPath = savedPath;
        }
        const update = createImageGenerationCompleteUpdate(item) as Extract<
            ReturnType<typeof createImageGenerationCompleteUpdate>,
            { sessionUpdate: "tool_call_update" }
        >;

        expect(update.locations).toBeUndefined();
        expect(update.content).toEqual([{
            type: "content",
            content: {
                type: "image",
                data: "iVBORw0KGgo=",
                mimeType: "image/png",
            },
        }]);
    });

    it("preserves failed status while reporting the saved image location", () => {
        const update = createImageGenerationCompleteUpdate(imageGenerationItem({ status: "failed" }));

        expect(update).toMatchObject({
            status: "failed",
            locations: [{ path: "/tmp/codex/generated-blue-square.png" }],
        });
    });
});

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
                    savedPath: "/tmp/codex/generated-completed-only.png",
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
