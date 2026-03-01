import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from "../acp-test-utils";
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

    async function setupAndSendNotifications(notifications: ServerNotification[]) {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null },
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: sessionId,
            turn: { id: "turn-id", items: [], status: "completed", error: null },
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "test prompt" }],
        });

        mockFixture.clearAcpConnectionDump();

        for (const notification of notifications) {
            mockFixture.sendServerNotification(notification);
        }

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });
    }

    it("maps fuzzy file search as search tool call flow", async () => {
        const updated1: ServerNotification = {
            method: "fuzzyFileSearch/sessionUpdated",
            params: {
                sessionId: "search-1",
                query: "event handler",
                files: [
                    { root: "/repo", path: "src/CodexEventHandler.ts", file_name: "CodexEventHandler.ts", score: 0.98, indices: [0, 1] },
                    { root: "/repo", path: "src/CodexToolCallMapper.ts", file_name: "CodexToolCallMapper.ts", score: 0.85, indices: [2, 3] },
                ],
            },
        };
        const updated2: ServerNotification = {
            method: "fuzzyFileSearch/sessionUpdated",
            params: {
                sessionId: "search-1",
                query: "event handler",
                files: [
                    { root: "/repo", path: "src/CodexEventHandler.ts", file_name: "CodexEventHandler.ts", score: 0.99, indices: [0, 1] },
                ],
            },
        };
        const completed: ServerNotification = {
            method: "fuzzyFileSearch/sessionCompleted",
            params: {
                sessionId: "search-1",
            },
        };

        await setupAndSendNotifications([updated1, updated2, completed]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/fuzzy-file-search-flow.json"
        );
    });
});
