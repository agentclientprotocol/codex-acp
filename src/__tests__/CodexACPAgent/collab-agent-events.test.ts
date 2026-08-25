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
                elicitation: {url: {}},
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

    it("keeps the legacy tool-call lifecycle without subagent capability and root-routes permissions", async () => {
        await mockFixture.getCodexAcpAgent().initialize({
            protocolVersion: 1,
            clientCapabilities: {elicitation: {form: {}, url: {}}},
        });
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

        const collaborationUpdates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.toolCallId === "call-spawn-weather");
        expect(collaborationUpdates).toMatchObject([
            {sessionUpdate: "tool_call", title: "spawnAgent", status: "in_progress"},
            {sessionUpdate: "tool_call_update", title: "spawnAgent", status: "completed"},
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
        expect(permissionRequest?.args[0].sessionId).toBe(sessionId);

        await mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: "thread-paris",
                turnId: "turn-child",
                startedAtMs: 0,
                item: {
                    type: "fileChange",
                    id: "child-file-change",
                    changes: [{path: "/workspace/child.ts", kind: {type: "update", move_path: null}, diff: "+child"}],
                    status: "inProgress",
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        await mockFixture.sendServerRequest("item/fileChange/requestApproval", {
            threadId: "thread-paris",
            turnId: "turn-child",
            itemId: "child-file-change",
            startedAtMs: 0,
            reason: "Edit child file",
            grantRoot: "/workspace",
        });
        const filePermission = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "requestPermission"
                && event.args[0].toolCall.toolCallId === "child-file-change");
        expect(filePermission?.args[0].toolCall.locations).toEqual([{path: "/workspace/child.ts"}]);

        mockFixture.setElicitationResponse({action: "accept", content: {answer: "yes"}});
        await mockFixture.sendServerRequest("mcpServer/elicitation/request", {
            threadId: "thread-paris",
            turnId: "turn-child",
            serverName: "child-server",
            mode: "form",
            _meta: null,
            message: "Continue?",
            requestedSchema: {
                type: "object",
                properties: {answer: {type: "string"}},
                required: ["answer"],
            },
        });
        const elicitationRequest = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "createElicitation" && event.args[0].message === "Continue?");
        expect(elicitationRequest?.args[0].sessionId).toBe(sessionId);

        mockFixture.setElicitationResponse({action: "accept"});
        await mockFixture.sendServerRequest("mcpServer/elicitation/request", {
            threadId: "thread-paris",
            turnId: "turn-child",
            serverName: "child-server",
            mode: "url",
            _meta: null,
            message: "Authorize legacy child",
            url: "https://example.com/legacy-child",
            elicitationId: "legacy-child-url",
        });
        await mockFixture.sendServerNotification({
            method: "serverRequest/resolved",
            params: {threadId: "thread-paris", requestId: 7},
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        expect(mockFixture.getAcpConnectionEvents([])).toContainEqual(expect.objectContaining({
            method: "completeElicitation",
            args: [{elicitationId: "legacy-child-url"}],
        }));
    });

    it("keeps legacy subagent activity as a tool call without subagent capability", async () => {
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

        const activity = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .find(update => update.toolCallId === "call-spawn-weather");
        expect(activity).toMatchObject({
            sessionUpdate: "tool_call",
            title: "Start subagent weather_research",
            status: "completed",
        });
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
                    threadId: "child-1",
                    turn: {
                        id: "turn-child",
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
                    name: "Air architecture",
                    task: "Delegated task for Air architecture",
                    capabilities: {},
                },
            },
            {
                sessionId: "child-1",
                update: {
                    sessionUpdate: "subagent_spawned",
                    subagentSessionId: "grandchild-1",
                    name: "Tests",
                    task: "Delegated task for Tests",
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
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-weather",
                        kind: "started",
                        agentThreadId: "thread-paris",
                        agentPath: "/root/weather_research",
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
                    name: "Weather research",
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
        expect(permissionRequest).toBeUndefined();
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
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-root",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-child",
                        kind: "started",
                        agentThreadId: "child-1",
                        agentPath: "/root/researcher",
                    },
                },
            },
            collabItem("child-1", "child-1", "grandchild-1", "spawn-2", "running"),
            {
                method: "item/started",
                params: {
                    threadId: "child-1",
                    turnId: "turn-child-1",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-grandchild",
                        kind: "started",
                        agentThreadId: "grandchild-1",
                        agentPath: "/root/researcher/tester",
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
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-child",
                        kind: "started",
                        agentThreadId: "child-1",
                        agentPath: "/root/researcher",
                    },
                },
            },
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
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "activity-child",
                        kind: "started",
                        agentThreadId: "child-1",
                        agentPath: "/root/researcher",
                    },
                },
            },
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

    it("waits for a real child terminal state before returning the parent prompt", async () => {
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
        await mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "activity-child",
                    kind: "started",
                    agentThreadId: "child-1",
                    agentPath: "/root/researcher",
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        await mockFixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: sessionId,
                turn: {
                    ...completedTurn,
                    itemsView: "notLoaded",
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        completeTurn();
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

        let promptSettled = false;
        void prompt.finally(() => { promptSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(promptSettled).toBe(false);

        spawn("completed");
        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
        const terminal = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "sessionUpdate"
                && event.args[0].update.sessionUpdate === "subagent_state_update"
                && event.args[0].update.subagentSessionId === "child-1");
        expect(terminal?.args[0].update.state).toBe("completed");
    });

    it("returns cancelled when cancellation interrupts the post-turn child wait", async () => {
        await initializeNativeSubagents();
        const appServer = mockFixture.getCodexAppServerClient();
        const runningTurn = {id: "cancel-root-turn", items: [], status: "inProgress" as const, error: null};
        const completedTurn = {...runningTurn, status: "completed" as const};
        let completeTurn!: () => void;
        appServer.turnStart = vi.fn().mockResolvedValue({turn: runningTurn});
        appServer.awaitTurnCompleted = vi.fn().mockReturnValue(new Promise(resolve => {
            completeTurn = () => resolve({threadId: sessionId, turn: completedTurn});
        }));
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        const controller = new AbortController();
        const prompt = mockFixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{type: "text", text: "Delegate then cancel"}],
        }, controller.signal);
        await vi.waitFor(() => expect(appServer.turnStart).toHaveBeenCalled());
        await mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: runningTurn.id,
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "cancel-live-activity",
                    kind: "started",
                    agentThreadId: "cancel-live-child",
                    agentPath: "/root/cancel_live",
                },
            },
        });
        await mockFixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: sessionId,
                turn: {
                    ...completedTurn,
                    itemsView: "notLoaded",
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        completeTurn();
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        let promptSettled = false;
        void prompt.finally(() => { promptSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(promptSettled).toBe(false);

        controller.abort();
        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        const terminal = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "sessionUpdate"
                && event.args[0].update.sessionUpdate === "subagent_state_update"
                && event.args[0].update.subagentSessionId === "cancel-live-child");
        expect(terminal?.args[0].update.state).toBe("cancelled");
    });

    it("waits for a pending spawn without publishing fallback identity and suppresses late activity", async () => {
        await initializeNativeSubagents();
        const appServer = mockFixture.getCodexAppServerClient();
        const turn = {id: "turn-1", items: [], status: "inProgress" as const, error: null};
        const completedTurn = {...turn, status: "completed" as const};
        let completeTurn!: () => void;
        appServer.turnStart = vi.fn().mockResolvedValue({turn});
        appServer.awaitTurnCompleted = vi.fn().mockReturnValue(new Promise(resolve => {
            completeTurn = () => resolve({threadId: sessionId, turn: completedTurn});
        }));
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
                    id: "spawn-without-activity",
                    tool: "spawnAgent",
                    status: status === "running" ? "inProgress" : "completed",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["child-without-activity"],
                    prompt: "Child task",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {
                        "child-without-activity": {status, message: null},
                    },
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
        await mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-1",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "late-activity",
                    kind: "started",
                    agentThreadId: "child-without-activity",
                    agentPath: "/root/late_identity",
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        const lifecycle = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.subagentSessionId === "child-without-activity");
        expect(lifecycle).toEqual([]);
    });

    it("reopens a pending child that terminated before its first activity", async () => {
        const router = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(mockFixture.getAcpConnection(), sessionId),
        );
        await router.handle({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "pre-activity-spawn",
                    tool: "spawnAgent",
                    status: "inProgress",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["pre-activity-child"],
                    prompt: "Retryable task",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {"pre-activity-child": {status: "running", message: null}},
                },
            },
        });
        await router.handle({
            method: "turn/completed",
            params: {
                threadId: "pre-activity-child",
                turn: {
                    id: "first-child-turn",
                    items: [],
                    itemsView: "notLoaded",
                    status: "failed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        await router.handle({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "pre-activity-resume",
                    tool: "resumeAgent",
                    status: "completed",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["pre-activity-child"],
                    prompt: null,
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {"pre-activity-child": {status: "running", message: null}},
                },
            },
        });
        const activity: ServerNotification = {
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "resumed-pre-activity",
                    kind: "started",
                    agentThreadId: "pre-activity-child",
                    agentPath: "/root/retried",
                },
            },
        };
        expect(await router.handle(activity)).toBe(true);
        const output: ServerNotification = {
            method: "item/agentMessage/delta",
            params: {
                threadId: "pre-activity-child",
                turnId: "second-child-turn",
                itemId: "retried-output",
                delta: "Now running",
            },
        };
        expect(router.shouldIgnore(output)).toBe(false);
        expect(router.notificationSessionId(output)).toBe("pre-activity-child:generation:2");
        const spawn = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "sessionUpdate"
                && event.args[0].update.subagentSessionId === "pre-activity-child:generation:2");
        expect(spawn?.args[0].update).toMatchObject({
            sessionUpdate: "subagent_spawned",
            task: "Retryable task",
        });
    });

    it("finishes only the child whose turn completed", async () => {
        await initializeNativeSubagents();
        const activity = (child: string): ServerNotification => ({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-root",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: `activity-${child}`,
                    kind: "started",
                    agentThreadId: child,
                    agentPath: `/root/${child}`,
                },
            },
        });
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            activity("child-a"),
            activity("child-b"),
            {
                method: "turn/completed",
                params: {
                    threadId: "child-a",
                    turn: {
                        id: "turn-child-a",
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

        const terminalUpdates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.sessionUpdate === "subagent_state_update");
        expect(terminalUpdates).toMatchObject([
            {subagentSessionId: "child-a", state: "completed"},
        ]);
    });

    it("keeps child turn boundaries out of the root event handler", async () => {
        await initializeNativeSubagents();
        const turn = (id: string, status: "inProgress" | "completed") => ({
            id,
            items: [],
            itemsView: "notLoaded" as const,
            status,
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        });
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "turn/started",
                params: {threadId: sessionId, turn: turn("root-turn", "inProgress")},
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "root-turn",
                    itemId: "root-message",
                    delta: "Root output",
                },
            },
        ]);
        expect(sessionState.currentTurnId).toBe("root-turn");

        await mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "child-activity",
                    kind: "started",
                    agentThreadId: "child-turn-thread",
                    agentPath: "/root/child_turn",
                },
            },
        });
        await mockFixture.sendServerNotification({
            method: "turn/started",
            params: {
                threadId: "child-turn-thread",
                turn: turn("child-turn", "inProgress"),
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        expect(sessionState.currentTurnId).toBe("root-turn");

        await mockFixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: "child-turn-thread",
                turn: turn("child-turn", "completed"),
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        expect(sessionState.currentTurnId).toBe("root-turn");

        await mockFixture.sendServerNotification({
            method: "turn/completed",
            params: {threadId: sessionId, turn: turn("root-turn", "completed")},
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        expect(sessionState.currentTurnId).toBeNull();
    });

    it("waits to address child interactions until the activity announces the session", async () => {
        await initializeNativeSubagents();
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-root",
                    startedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id: "pending-spawn",
                        tool: "spawnAgent",
                        status: "inProgress",
                        senderThreadId: sessionId,
                        receiverThreadIds: ["pending-child"],
                        prompt: "Pending task",
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {"pending-child": {status: "running", message: null}},
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-root",
                    itemId: "root-progress",
                    delta: "Delegating",
                },
            },
        ]);
        mockFixture.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
        let resolved = false;
        const approval = mockFixture.sendServerRequest("item/commandExecution/requestApproval", {
            threadId: "pending-child",
            turnId: "turn-child",
            itemId: "pending-command",
            reason: "Run child command",
            startedAtMs: 0,
            environmentId: null,
            proposedExecpolicyAmendment: null,
        }).finally(() => { resolved = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(resolved).toBe(false);
        expect(mockFixture.getAcpConnectionEvents([]).some(event => event.method === "requestPermission")).toBe(false);

        await mockFixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-root",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "pending-activity",
                    kind: "started",
                    agentThreadId: "pending-child",
                    agentPath: "/root/pending_child",
                },
            },
        });
        await approval;
        const request = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "requestPermission"
                && event.args[0].toolCall.toolCallId === "pending-command");
        expect(request?.args[0].sessionId).toBe("pending-child");
    });

    it("uses a new ACP child generation when Codex reactivates a terminal thread", async () => {
        await initializeNativeSubagents();
        const childTurn = (status: "completed" | "inProgress"): ServerNotification => ({
            method: status === "completed" ? "turn/completed" : "turn/started",
            params: {
                threadId: "resumable-child",
                turn: {
                    id: `child-turn-${status}`,
                    items: [],
                    itemsView: "notLoaded",
                    status,
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "root-turn",
                    startedAtMs: 0,
                    item: {
                        type: "subAgentActivity",
                        id: "resumable-activity",
                        kind: "started",
                        agentThreadId: "resumable-child",
                        agentPath: "/root/resumable",
                    },
                },
            },
            childTurn("completed"),
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "root-turn",
                    startedAtMs: 0,
                    item: {
                        type: "collabAgentToolCall",
                        id: "resume-call",
                        tool: "resumeAgent",
                        status: "completed",
                        senderThreadId: sessionId,
                        receiverThreadIds: ["resumable-child"],
                        prompt: null,
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {"resumable-child": {status: "running", message: null}},
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: "resumable-child",
                    turnId: "resumed-turn",
                    itemId: "resumed-message",
                    delta: "Resumed output",
                },
            },
        ]);
        const updates = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        expect(updates).toContainEqual(expect.objectContaining({
            sessionId,
            update: expect.objectContaining({
                sessionUpdate: "subagent_spawned",
                subagentSessionId: "resumable-child:generation:2",
            }),
        }));
        expect(updates).toContainEqual(expect.objectContaining({
            sessionId: "resumable-child:generation:2",
            update: expect.objectContaining({messageId: "resumed-message"}),
        }));
    });

    it("attaches a resumed nested child to the current parent generation", async () => {
        const router = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(mockFixture.getAcpConnection(), sessionId),
        );
        const activity = (threadId: string, path: string): ServerNotification => ({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: `activity-${threadId}`,
                    kind: "started",
                    agentThreadId: threadId,
                    agentPath: path,
                },
            },
        });
        const completed = (threadId: string): ServerNotification => ({
            method: "turn/completed",
            params: {
                threadId,
                turn: {
                    id: `turn-${threadId}`,
                    items: [],
                    itemsView: "notLoaded",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        });
        const resume = (senderThreadId: string, childThreadId: string): ServerNotification => ({
            method: "item/started",
            params: {
                threadId: senderThreadId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: `resume-${childThreadId}`,
                    tool: "resumeAgent",
                    status: "completed",
                    senderThreadId,
                    receiverThreadIds: [childThreadId],
                    prompt: null,
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {[childThreadId]: {status: "running", message: null}},
                },
            },
        });

        await router.handle(activity("parent-thread", "/root/parent"));
        await router.handle(activity("nested-thread", "/root/parent/nested"));
        await router.handle(completed("nested-thread"));
        await router.handle(completed("parent-thread"));
        await router.handle(resume(sessionId, "parent-thread"));
        mockFixture.clearAcpConnectionDump();
        await router.handle(resume("parent-thread", "nested-thread"));

        const nestedSpawn = mockFixture.getAcpConnectionEvents([])
            .find(event => event.method === "sessionUpdate"
                && event.args[0].update.subagentSessionId === "nested-thread:generation:2");
        expect(nestedSpawn?.args[0].sessionId).toBe("parent-thread:generation:2");
    });

    it("bounds notifications buffered before a child is announced", async () => {
        const router = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(mockFixture.getAcpConnection(), sessionId),
        );
        await router.handle({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "bounded-spawn",
                    tool: "spawnAgent",
                    status: "inProgress",
                    senderThreadId: sessionId,
                    receiverThreadIds: ["bounded-child"],
                    prompt: "Bounded task",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {"bounded-child": {status: "running", message: null}},
                },
            },
        });
        for (let index = 0; index < 300; index++) {
            await router.handle({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "bounded-child",
                    turnId: "child-turn",
                    itemId: `buffered-${index}`,
                    delta: String(index),
                },
            });
        }
        await router.handle({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "bounded-activity",
                    kind: "started",
                    agentThreadId: "bounded-child",
                    agentPath: "/root/bounded",
                },
            },
        });

        const buffered = router.takeBufferedNotifications();
        expect(buffered).toHaveLength(256);
        expect((buffered[0]!.params as {itemId: string}).itemId).toBe("buffered-44");
    });

    it("publishes a terminal child state exactly once under concurrent completion", async () => {
        const router = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(mockFixture.getAcpConnection(), sessionId),
        );
        await router.handle({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "root-turn",
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "atomic-activity",
                    kind: "started",
                    agentThreadId: "atomic-child",
                    agentPath: "/root/atomic",
                },
            },
        });
        mockFixture.clearAcpConnectionDump();
        const completed: ServerNotification = {
            method: "turn/completed",
            params: {
                threadId: "atomic-child",
                turn: {
                    id: "atomic-turn",
                    items: [],
                    itemsView: "notLoaded",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        };
        await Promise.all([router.handle(completed), router.handle(completed)]);
        const terminal = mockFixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate"
                && event.args[0].update.sessionUpdate === "subagent_state_update");
        expect(terminal).toHaveLength(1);
    });
});
