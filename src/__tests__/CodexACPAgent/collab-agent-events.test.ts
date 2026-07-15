import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import type { SessionState } from "../../CodexAcpServer";
import { AgentMode } from "../../AgentMode";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("CodexEventHandler - collab agent tool call events", () => {
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

    it("maps live collab agent tool calls to ACP tool call updates", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id: "call-spawn-weather",
                        tool: "spawnAgent",
                        status: "inProgress",
                        senderThreadId: "thread-main",
                        receiverThreadIds: ["thread-paris"],
                        prompt: "Find the current weather in Paris.",
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {
                            "thread-paris": {
                                status: "running",
                                message: "Checking weather",
                            },
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
                        type: "collabAgentToolCall",
                        id: "call-spawn-weather",
                        tool: "spawnAgent",
                        status: "completed",
                        senderThreadId: "thread-main",
                        receiverThreadIds: ["thread-paris"],
                        prompt: "Find the current weather in Paris.",
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {
                            "thread-paris": {
                                status: "completed",
                                message: null,
                            },
                        },
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(`${mockFixture.getAcpConnectionDump([])}\n`).toMatchFileSnapshot(
            "data/collab-agent-tool-call-flow.json"
        );
    });

    it("maps live subagent activity to an ACP tool call", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "call-spawn-weather",
                        kind: "started",
                        agentThreadId: "thread-paris",
                        agentPath: "/root/weather_research",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(`${mockFixture.getAcpConnectionDump([])}\n`).toMatchFileSnapshot(
            "data/subagent-activity-flow.json"
        );
    });
});
