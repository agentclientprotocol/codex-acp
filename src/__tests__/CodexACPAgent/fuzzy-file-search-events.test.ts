import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - fuzzy file search events", () => {
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

    it("maps fuzzy file search as search tool call flow", async () => {
        const events: { method: string; args: any[] }[] = [];
        mockFixture.onAcpConnectionEvent((event) => {
            events.push(event);
        });

        const updated1: ServerNotification = {
            method: "fuzzyFileSearch/sessionUpdated",
            params: {
                sessionId: "search-1",
                query: "event handler",
                files: [
                    { root: "/repo", path: "src/CodexEventHandler.ts", match_type: "file", file_name: "CodexEventHandler.ts", score: 0.98, indices: [0, 1] },
                    { root: "/repo", path: "src/CodexToolCallMapper.ts", match_type: "file", file_name: "CodexToolCallMapper.ts", score: 0.85, indices: [2, 3] },
                ],
            },
        };
        const updated2: ServerNotification = {
            method: "fuzzyFileSearch/sessionUpdated",
            params: {
                sessionId: "search-1",
                query: "event handler",
                files: [
                    { root: "/repo", path: "src/CodexEventHandler.ts", match_type: "file", file_name: "CodexEventHandler.ts", score: 0.99, indices: [0, 1] },
                ],
            },
        };
        const completed: ServerNotification = {
            method: "fuzzyFileSearch/sessionCompleted",
            params: {
                sessionId: "search-1",
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [updated1, updated2, completed]);

        expect(events).toHaveLength(3);
        expect(events[0]).toEqual({
            method: "sessionUpdate",
            args: [
                {
                    sessionId: "test-session-id",
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "fuzzyFileSearch.search-1",
                        kind: "search",
                        title: "Search for 'event handler'",
                        status: "in_progress",
                        locations: [
                            { path: "/repo/src/CodexEventHandler.ts" },
                            { path: "/repo/src/CodexToolCallMapper.ts" },
                        ],
                        rawInput: {
                            query: "event handler",
                        },
                    },
                },
            ],
        });
        expect(events[1]).toEqual({
            method: "sessionUpdate",
            args: [
                {
                    sessionId: "test-session-id",
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "fuzzyFileSearch.search-1",
                        title: "Search for 'event handler'",
                        status: "in_progress",
                        locations: [{ path: "/repo/src/CodexEventHandler.ts" }],
                    },
                },
            ],
        });
        expect(events[2]).toEqual({
            method: "sessionUpdate",
            args: [
                {
                    sessionId: "test-session-id",
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "fuzzyFileSearch.search-1",
                        status: "completed",
                    },
                },
            ],
        });
    });
});
