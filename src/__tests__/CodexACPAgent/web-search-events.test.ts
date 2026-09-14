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

describe("CodexEventHandler - web search events", () => {
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

    it("maps web search start and completion to a search tool call", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "webSearch",
                        id: "web-search-1",
                        query: "agent client protocol",
                        results: null,
                        action: {
                            type: "search",
                            query: "agent client protocol",
                            queries: null,
                        },
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
                        type: "webSearch",
                        id: "web-search-1",
                        query: "agent client protocol",
                        results: null,
                        action: {
                            type: "search",
                            query: "agent client protocol",
                            queries: null,
                        },
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/web-search-start-and-complete.json"
        );
    });

    it("formats open-page and find-in-page web search actions", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "webSearch",
                        id: "web-open-1",
                        query: "https://agentclientprotocol.com",
                        results: null,
                        action: {
                            type: "openPage",
                            url: "https://agentclientprotocol.com",
                        },
                    },
                },
            },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "webSearch",
                        id: "web-find-1",
                        query: "protocol",
                        results: null,
                        action: {
                            type: "findInPage",
                            url: "https://agentclientprotocol.com/protocol",
                            pattern: "tool calls",
                        },
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/web-search-action-titles.json"
        );
    });
});
