import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "../../CodexAcpServer";
import type { ServerNotification } from "../../app-server";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import { AgentMode } from "../../AgentMode";

describe("CodexEventHandler - Guardian approval review events", () => {
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

    it("maps Guardian review start and completion to a think tool call flow", async () => {
        const started: ServerNotification = {
            method: "item/autoApprovalReview/started",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                startedAtMs: 1000,
                reviewId: "review-1",
                targetItemId: "command-1",
                review: {
                    status: "inProgress",
                    riskLevel: "medium",
                    userAuthorization: "unknown",
                    rationale: "Checking whether this command should run automatically.",
                },
                action: {
                    type: "execve",
                    source: "unifiedExec",
                    program: "/bin/ls",
                    argv: ["/bin/ls", "-l"],
                    cwd: "/test/project",
                },
            },
        };
        const completed: ServerNotification = {
            method: "item/autoApprovalReview/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                startedAtMs: 1000,
                completedAtMs: 1500,
                reviewId: "review-1",
                targetItemId: "command-1",
                decisionSource: "agent",
                review: {
                    status: "approved",
                    riskLevel: "low",
                    userAuthorization: "medium",
                    rationale: "The command only lists files.",
                },
                action: {
                    type: "execve",
                    source: "unifiedExec",
                    program: "/bin/ls",
                    argv: ["/bin/ls", "-l"],
                    cwd: "/test/project",
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [started, completed]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/guardian-approval-review-flow.json"
        );
    });

    it("creates a completed Guardian review tool call when the start event was missed", async () => {
        const completed: ServerNotification = {
            method: "item/autoApprovalReview/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                startedAtMs: 1000,
                completedAtMs: 1800,
                reviewId: "review-orphaned",
                targetItemId: null,
                decisionSource: "agent",
                review: {
                    status: "denied",
                    riskLevel: "high",
                    userAuthorization: "low",
                    rationale: "The network target is not permitted.",
                },
                action: {
                    type: "networkAccess",
                    target: "",
                    host: "api.example.com",
                    protocol: "https",
                    port: 443,
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [completed]);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/guardian-approval-review-completed-without-start.json"
        );
    });
});
