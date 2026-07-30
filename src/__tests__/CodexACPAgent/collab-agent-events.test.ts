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

    // Covers one activity per subagent run, including controls, resume, and failed spawn.
    it("folds collaboration controls into coherent subagent run activities", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-initial",
                        kind: "started",
                        agentThreadId: "thread-paris",
                        agentPath: "/root/weather_audit",
                    },
                },
            },
            emptyWait("wait-1", "started"),
            childMessage("child-result-1", "@agentclientprotocol/codex-acp"),
            childTurnCompleted("child-turn-1"),
            emptyWait("wait-1", "completed"),
            collabStarted("resume-1", "resumeAgent", "running"),
            collabCompleted("resume-1", "resumeAgent", "running"),
            collabCompleted("send-1", "sendInput", "running", "Check alerts too."),
            childMessage("child-result-2", "No alerts found."),
            childTurnCompleted("child-turn-2"),
            collabCompleted("close-1", "closeAgent", "shutdown"),
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id: "spawn-failed",
                        tool: "spawnAgent",
                        status: "failed",
                        senderThreadId: "thread-main",
                        receiverThreadIds: [],
                        prompt: "Try an unavailable worker.",
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {},
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(`${mockFixture.getAcpConnectionDump([])}\n`).toMatchFileSnapshot(
            "data/collab-agent-tool-call-flow.json"
        );
    });

    function collabStarted(
        id: string,
        tool: "resumeAgent",
        agentStatus: "running",
    ): ServerNotification {
        return {
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                startedAtMs: 0,
                item: collabItem(id, tool, "inProgress", agentStatus),
            },
        };
    }

    function emptyWait(id: string, lifecycle: "started" | "completed"): ServerNotification {
        return lifecycle === "started"
            ? {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id,
                        tool: "wait",
                        status: "inProgress",
                        senderThreadId: "thread-main",
                        receiverThreadIds: [],
                        prompt: null,
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {},
                    },
                },
            }
            : {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id,
                        tool: "wait",
                        status: "completed",
                        senderThreadId: "thread-main",
                        receiverThreadIds: [],
                        prompt: null,
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {},
                    },
                },
            };
    }

    function childMessage(id: string, text: string): ServerNotification {
        return {
            method: "item/completed",
            params: {
                threadId: "thread-paris",
                turnId: "child-turn",
                completedAtMs: 0,
                item: {
                    type: "agentMessage",
                    id,
                    text,
                    phase: "final_answer",
                    memoryCitation: null,
                },
            },
        };
    }

    function childTurnCompleted(turnId: string): ServerNotification {
        return {
            method: "turn/completed",
            params: {
                threadId: "thread-paris",
                turn: {
                    id: turnId,
                    items: [],
                    itemsView: "notLoaded",
                    status: "completed",
                    error: null,
                    startedAt: 0,
                    completedAt: 1,
                    durationMs: 1000,
                },
            },
        };
    }

    function collabCompleted(
        id: string,
        tool: "wait" | "resumeAgent" | "sendInput" | "closeAgent",
        agentStatus: "completed" | "running" | "shutdown",
        prompt: string | null = null,
    ): ServerNotification {
        return {
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                completedAtMs: 0,
                item: collabItem(id, tool, "completed", agentStatus, prompt),
            },
        };
    }

    function collabItem(
        id: string,
        tool: "wait" | "resumeAgent" | "sendInput" | "closeAgent",
        status: "inProgress" | "completed",
        agentStatus: "completed" | "running" | "shutdown",
        prompt: string | null = null,
    ): Extract<ServerNotification, { method: "item/completed" }>["params"]["item"] & { type: "collabAgentToolCall" } {
        return {
            type: "collabAgentToolCall",
            id,
            tool,
            status,
            senderThreadId: "thread-main",
            receiverThreadIds: ["thread-paris"],
            prompt,
            model: null,
            reasoningEffort: null,
            agentsStates: {
                "thread-paris": {
                    status: agentStatus,
                    message: agentStatus === "running" ? "Working" : null,
                },
            },
        };
    }
});
