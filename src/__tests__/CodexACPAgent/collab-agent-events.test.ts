import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import type { SessionState } from "../../CodexAcpServer";
import { AgentMode } from "../../AgentMode";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import {CodexSubagentEventRouter} from "../../subagents/CodexSubagentEventRouter";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("CodexEventHandler - collab agent tool call events", () => {
    let mockFixture: CodexMockTestFixture;
    let sessionState: SessionState;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        sessionState = createTestSessionState({
            sessionId,
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
        });
        vi.clearAllMocks();
    });

    async function initializeNativeSubagents() {
        const response = await mockFixture.getCodexAcpAgent().initialize({
            protocolVersion: 1,
            clientCapabilities: {
                _meta: {
                    jetbrains: {
                        air: {version: 1, capabilities: ["nativeSubagentSessions"]},
                    },
                },
            },
        });
        sessionState.subagents = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(mockFixture.getAcpConnection(), sessionId),
        );
        return response;
    }

    it("hides collaboration lifecycle when the client lacks subagent capability but keeps permissions", async () => {
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
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "parent-message",
                    delta: "Visible parent output",
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        expect(JSON.stringify(mockFixture.getAcpConnectionEvents([]))).not.toContain("call-spawn-weather");

        mockFixture.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
        await mockFixture.sendServerRequest("item/commandExecution/requestApproval", {
            threadId: "thread-paris",
            turnId: "turn-child",
            itemId: "child-command",
            reason: "Check the weather service",
            startedAtMs: 0,
            environmentId: null,
            proposedExecpolicyAmendment: null,
        });
        const permissionRequest = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "requestPermission" && event.args[0].toolCall.toolCallId === "child-command");
        expect(permissionRequest?.args[0].sessionId).toBe(sessionId);
    });

    it("hides legacy subagent activity when the client lacks subagent capability", async () => {
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
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "parent-message",
                    delta: "Visible parent output",
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        expect(JSON.stringify(mockFixture.getAcpConnectionEvents([]))).not.toContain("call-spawn-weather");
    });

    it("promotes subagent activity to native lifecycle when collaboration items are absent", async () => {
        await initializeNativeSubagents();
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-started",
                        kind: "started",
                        agentThreadId: "child-1",
                        agentPath: "/root/air_architecture",
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
                        type: "subAgentActivity",
                        id: "activity-started",
                        kind: "started",
                        agentThreadId: "child-1",
                        agentPath: "/root/air_architecture",
                    },
                },
            },
            {
                method: "item/started",
                params: {
                    threadId: "child-1",
                    turnId: "turn-child",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "nested-started",
                        kind: "started",
                        agentThreadId: "grandchild-1",
                        agentPath: "/root/air_architecture/tests",
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: "grandchild-1",
                    turnId: "turn-grandchild",
                    itemId: "grandchild-message",
                    delta: "Nested result",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: "child-1",
                    turnId: "turn-child",
                    completedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "nested-interrupted",
                        kind: "interrupted",
                        agentThreadId: "grandchild-1",
                        agentPath: "/root/air_architecture/tests",
                    },
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: sessionId,
                    turn: {
                        id: "turn-1",
                        items: [],
                        itemsView: "notLoaded",
                        status: "completed",
                        error: null,
                        startedAt: null,
                        completedAt: null,
                        durationMs: null,
                    },
                },
            },
        ]);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        expect(updates).toEqual([
            {
                sessionId,
                update: {
                    sessionUpdate: "subagent_spawned",
                    subagentSessionId: "child-1",
                    name: "air_architecture",
                    task: "Delegated task for air_architecture",
                    capabilities: {},
                },
            },
            {
                sessionId: "child-1",
                update: {
                    sessionUpdate: "subagent_spawned",
                    subagentSessionId: "grandchild-1",
                    name: "tests",
                    task: "Delegated task for tests",
                    capabilities: {},
                },
            },
            {
                sessionId: "grandchild-1",
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {type: "text", text: "Nested result"},
                    messageId: "grandchild-message",
                },
            },
            {
                sessionId: "child-1",
                update: {
                    sessionUpdate: "subagent_state_update",
                    subagentSessionId: "grandchild-1",
                    state: "cancelled",
                },
            },
            {
                sessionId,
                update: {
                    sessionUpdate: "subagent_state_update",
                    subagentSessionId: "child-1",
                    state: "completed",
                },
            },
        ]);
    });

    it("does not represent the root activity as a subagent", async () => {
        await initializeNativeSubagents();
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "root-activity",
                        kind: "started",
                        agentThreadId: "root-activity-thread",
                        agentPath: "/root",
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
                        type: "subAgentActivity",
                        id: "root-activity",
                        kind: "started",
                        agentThreadId: "root-activity-thread",
                        agentPath: "/root/",
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "parent-message",
                    delta: "Visible root output",
                },
            },
        ]);

        expect(mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update))
            .not.toContainEqual(expect.objectContaining({sessionUpdate: "subagent_spawned"}));
    });

    it("emits native lifecycle and routes child output after capability negotiation", async () => {
        const initializeResponse = await initializeNativeSubagents();
        expect(
            (initializeResponse.agentCapabilities?.sessionCapabilities as {subagents?: unknown}).subagents
        ).toEqual({});
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
                            "thread-paris": {status: "running", message: "Checking weather"},
                        },
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: "thread-paris",
                    turnId: "turn-child",
                    itemId: "child-message",
                    delta: "Weather found",
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
                            "thread-paris": {status: "completed", message: null},
                        },
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        expect(updates).toEqual([
            {
                sessionId,
                update: {
                    sessionUpdate: "subagent_spawned",
                    subagentSessionId: "thread-paris",
                    name: "Agent ad-paris",
                    task: "Find the current weather in Paris.",
                    capabilities: {},
                },
            },
            {
                sessionId: "thread-paris",
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {type: "text", text: "Weather found"},
                    messageId: "child-message",
                },
            },
            {
                sessionId,
                update: {
                    sessionUpdate: "subagent_state_update",
                    subagentSessionId: "thread-paris",
                    state: "completed",
                },
            },
        ]);

        mockFixture.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
        await mockFixture.sendServerRequest("item/commandExecution/requestApproval", {
            threadId: "thread-paris",
            turnId: "turn-child",
            itemId: "child-command",
            reason: "Check the weather service",
            startedAtMs: 0,
            environmentId: null,
            proposedExecpolicyAmendment: null,
        });
        const permissionRequest = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "requestPermission" && event.args[0].toolCall.toolCallId === "child-command");
        expect(permissionRequest?.args[0].sessionId).toBe("thread-paris");
    });

    it("routes nested agents through their immediate parent sessions", async () => {
        await initializeNativeSubagents();
        const collabItem = (
            threadId: string,
            senderThreadId: string,
            receiverThreadId: string,
            id: string,
            status: "running" | "completed",
        ): ServerNotification => ({
            method: status === "running" ? "item/started" : "item/completed",
            params: {
                threadId,
                turnId: `turn-${threadId}`,
                ...(status === "running" ? {startedAtMs: 0} : {completedAtMs: 0}),
                item: {
                    type: "collabAgentToolCall",
                    id,
                    tool: "spawnAgent",
                    status: status === "running" ? "inProgress" : "completed",
                    senderThreadId,
                    receiverThreadIds: [receiverThreadId],
                    prompt: `Task for ${receiverThreadId}`,
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {[receiverThreadId]: {status, message: null}},
                },
            },
        } as ServerNotification);
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            collabItem(sessionId, sessionId, "child-1", "spawn-1", "running"),
            collabItem("child-1", "child-1", "grandchild-1", "spawn-2", "running"),
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: "grandchild-1",
                    turnId: "turn-grandchild",
                    itemId: "grandchild-message",
                    delta: "Nested result",
                },
            },
            collabItem("child-1", "child-1", "grandchild-1", "spawn-2", "completed"),
            collabItem(sessionId, sessionId, "child-1", "spawn-1", "completed"),
        ]);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        expect(updates.map(({sessionId: target, update}) => [target, update.sessionUpdate])).toEqual([
            [sessionId, "subagent_spawned"],
            ["child-1", "subagent_spawned"],
            ["grandchild-1", "agent_message_chunk"],
            ["child-1", "subagent_state_update"],
            [sessionId, "subagent_state_update"],
        ]);
    });

    it("deduplicates lifecycle, rejects blank IDs, and ignores late child output", async () => {
        await initializeNativeSubagents();
        const spawn = (method: "item/started" | "item/completed"): ServerNotification => ({
            method,
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                ...(method === "item/started" ? {startedAtMs: 0} : {completedAtMs: 0}),
                item: {
                    type: "collabAgentToolCall",
                    id: "spawn",
                    tool: "spawnAgent",
                    status: method === "item/started" ? "inProgress" : "completed",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["", "child-1", "child-1"],
                    prompt: "Task",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {"child-1": {status: method === "item/started" ? "running" : "completed", message: null}},
                },
            },
        } as ServerNotification);
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            spawn("item/started"),
            spawn("item/completed"),
            spawn("item/completed"),
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: "child-1",
                    turnId: "turn-child",
                    itemId: "late-message",
                    delta: "Too late",
                },
            },
        ]);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates).toHaveLength(2);
        expect(updates.map(update => update.sessionUpdate)).toEqual([
            "subagent_spawned",
            "subagent_state_update",
        ]);
    });

    it("keeps unsupported collaboration controls visible in native mode", async () => {
        await initializeNativeSubagents();
        const collab = (
            method: "item/started" | "item/completed",
            tool: "spawnAgent" | "sendInput",
            id: string,
            status: "running" | "completed",
        ): ServerNotification => ({
            method,
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                ...(method === "item/started" ? {startedAtMs: 0} : {completedAtMs: 0}),
                item: {
                    type: "collabAgentToolCall",
                    id,
                    tool,
                    status: method === "item/started" ? "inProgress" : "completed",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["child-1"],
                    prompt: tool === "spawnAgent" ? "Child task" : "Additional direction",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {"child-1": {status, message: null}},
                },
            },
        } as ServerNotification);

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            collab("item/started", "spawnAgent", "spawn", "running"),
            collab("item/started", "sendInput", "send-input", "running"),
            collab("item/completed", "sendInput", "send-input", "running"),
            collab("item/completed", "spawnAgent", "spawn", "completed"),
        ]);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates.map(update => [update.sessionUpdate, update.toolCallId, update.title])).toEqual([
            ["subagent_spawned", undefined, undefined],
            ["tool_call", "send-input", "sendInput"],
            ["tool_call_update", "send-input", "sendInput"],
            ["subagent_state_update", undefined, undefined],
        ]);
    });

    it("falls back to tool representation when a native spawn cannot be represented", async () => {
        await initializeNativeSubagents();
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [{
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                completedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "self-spawn",
                    tool: "spawnAgent",
                    status: "failed",
                    senderThreadId: sessionId,
                    receiverThreadIds: [sessionId],
                    prompt: "Invalid task",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {},
                },
            },
        }]);

        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: "self-spawn",
            title: "spawnAgent",
            status: "failed",
        });
    });

    it("does not duplicate global notifications after subscribing to a child", async () => {
        await initializeNativeSubagents();
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id: "spawn",
                        tool: "spawnAgent",
                        status: "inProgress",
                        senderThreadId: sessionId,
                        receiverThreadIds: ["child-1"],
                        prompt: "Child task",
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {"child-1": {status: "running", message: null}},
                    },
                },
            },
            {method: "warning", params: {threadId: null, message: "Global warning"}},
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id: "spawn",
                        tool: "spawnAgent",
                        status: "completed",
                        senderThreadId: sessionId,
                        receiverThreadIds: ["child-1"],
                        prompt: "Child task",
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {"child-1": {status: "completed", message: null}},
                    },
                },
            },
        ]);

        const warningUpdates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.sessionUpdate === "agent_message_chunk"
                && update.content?.text.includes("Global warning"));
        expect(warningUpdates).toHaveLength(1);
    });

    it("keeps the parent prompt open until every announced child is terminal", async () => {
        await initializeNativeSubagents();
        const appServer = mockFixture.getCodexAppServerClient();
        const turn = {id: "turn-1", items: [], status: "inProgress" as const, error: null};
        const completedTurn = {...turn, status: "completed" as const};
        let completeTurn!: () => void;
        const completed = new Promise<{threadId: string; turn: typeof completedTurn}>(resolve => {
            completeTurn = () => resolve({threadId: sessionId, turn: completedTurn});
        });
        appServer.turnStart = vi.fn().mockResolvedValue({turn});
        appServer.awaitTurnCompleted = vi.fn().mockReturnValue(completed);
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);

        const prompt = mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{type: "text", text: "Delegate work"}],
        });
        await vi.waitFor(() => expect(appServer.turnStart).toHaveBeenCalled());
        const spawn = (status: "running" | "completed") => mockFixture.sendServerNotification({
            method: status === "running" ? "item/started" : "item/completed",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                ...(status === "running" ? {startedAtMs: 0} : {completedAtMs: 0}),
                item: {
                    type: "collabAgentToolCall",
                    id: "spawn",
                    tool: "spawnAgent",
                    status: status === "running" ? "inProgress" : "completed",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["child-1"],
                    prompt: "Child task",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {"child-1": {status, message: null}},
                },
            },
        });
        spawn("running");
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        completeTurn();

        let promptSettled = false;
        void prompt.finally(() => { promptSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(promptSettled).toBe(false);

        spawn("completed");
        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
    });
});
