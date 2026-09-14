import * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it, vi} from "vitest";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import {CodexSubagentEventRouter} from "../../subagents/CodexSubagentEventRouter";
import type {ServerNotification} from "../../app-server";
import type {Thread, ThreadItem, Turn} from "../../app-server/v2";
import {
    createCodexMockTestFixture,
    createTestModel,
    createTestSessionState,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import {createMockConnections} from "./test-utils";

const sessionId = "compaction-session";
const turnId = "compaction-turn";
const compactionId = "compaction-item";
const childSessionId = "compaction-child";
const childTurnId = "compaction-child-turn";
const compactionCapabilities: acp.ClientCapabilities = {
    session: {compaction: {}},
};

describe("session compaction", () => {
    it("keeps one timeline entity through item progress and completion", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [
            compactionStarted(),
            {
                method: "item/agentMessage/delta",
                params: {threadId: sessionId, turnId, itemId: "next-message", delta: "Continuing the task."},
            },
            compactionCompleted(),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-lifecycle.json",
        );
    });

    it.each(["before", "after"])("deduplicates thread/compacted %s item completion", async (order) => {
        const fixture = await createFixture();
        const compacted: ServerNotification = {
            method: "thread/compacted",
            params: {threadId: sessionId, turnId},
        };
        await sendNotifications(fixture, [
            compactionStarted(),
            ...(order === "before"
                ? [compacted, compactionCompleted()]
                : [compactionCompleted(), compacted]),
            compactionCompleted(),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-deduplicated.json",
        );
    });

    it("materializes an item completion without inventing an earlier start", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [compactionCompleted()]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-completed-only.json",
        );
    });

    it("materializes a legacy completion signal when no lifecycle item is available", async () => {
        const fixture = await createFixture();
        const compacted: ServerNotification = {
            method: "thread/compacted",
            params: {threadId: sessionId, turnId},
        };
        await sendNotifications(fixture, [compacted, compacted]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-thread-completed.json",
        );
    });

    it("keeps the original entity when a native completion follows the legacy signal", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [
            {method: "thread/compacted", params: {threadId: sessionId, turnId}},
            compactionCompleted(),
            compactionCompleted(),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-thread-completed.json",
        );
    });

    it("keeps separate compactions in the same turn distinct", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [
            compactionStarted(),
            compactionCompleted(),
            compactionStarted("second-compaction-item"),
            compactionCompleted("second-compaction-item"),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-multiple.json",
        );
    });

    it("preserves compaction identity when a later prompt replaces its event handler", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [compactionStarted(), compactionCompleted()]);
        const firstCompaction = fixture.getAcpConnectionEvents([]);
        await fixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "Continue again."}]});
        fixture.clearAcpConnectionDump();
        await sendNotifications(fixture, [
            compactionStarted(),
            compactionCompleted(),
            compactionStarted("second-compaction-item"),
            compactionCompleted("second-compaction-item"),
        ]);

        await expect(JSON.stringify([...firstCompaction, ...fixture.getAcpConnectionEvents([])], null, 2))
            .toMatchFileSnapshot("data/session-compaction-next-prompt.json");
    });

    it("delivers the lifecycle and finishes a manual /compact request", async () => {
        const fixture = await createFixture();
        const compactStart = vi.spyOn(fixture.getCodexAppServerClient(), "threadCompactStart");
        const prompt = fixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/compact"}]});
        await vi.waitFor(() => expect(compactStart).toHaveBeenCalledWith({threadId: sessionId}));
        await sendNotifications(fixture, [compactionStarted(), compactionCompleted()]);
        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-deduplicated.json",
        );
    });

    it("keeps equal compaction item IDs distinct in parent and native child sessions", async () => {
        const fixture = await createNativeChildFixture();
        await sendNotifications(fixture, [
            compactionStarted(),
            compactionStarted(compactionId, childSessionId, childTurnId),
            compactionCompleted(),
            compactionCompleted(compactionId, childSessionId, childTurnId),
            {
                method: "turn/completed",
                params: {threadId: childSessionId, turn: {...createTurn("completed"), id: childTurnId}},
            },
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-native-child-identities.json",
        );
    });

    it.each(["child", "parent"] as const)("cancels a native child compaction before the child closes when the %s is interrupted", async (interruptedSession) => {
        const fixture = await createNativeChildFixture();
        await sendNotifications(fixture, [
            compactionStarted(compactionId, childSessionId, childTurnId),
            {
                method: "turn/completed",
                params: {
                    threadId: interruptedSession === "child" ? childSessionId : sessionId,
                    turn: {
                        ...createTurn("interrupted"),
                        id: interruptedSession === "child" ? childTurnId : turnId,
                    },
                },
            },
            compactionCompleted(compactionId, childSessionId, childTurnId),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-native-child-interrupted.json",
        );
    });

    it("uses each child's collaboration terminal state to settle its compaction before closing", async () => {
        const fixture = await createNativeChildFixture();
        const failedChildSessionId = "failed-compaction-child";
        await sendNotifications(fixture, [
            nativeChildActivityStarted(failedChildSessionId),
            compactionStarted(compactionId, childSessionId, childTurnId),
            compactionStarted(compactionId, failedChildSessionId, childTurnId),
        ]);
        fixture.clearAcpConnectionDump();
        await sendNotifications(fixture, [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId,
                    completedAtMs: 1,
                    item: {
                        type: "collabAgentToolCall",
                        id: "wait-compaction-children",
                        tool: "wait",
                        status: "completed",
                        senderThreadId: sessionId,
                        receiverThreadIds: [childSessionId, failedChildSessionId],
                        prompt: null,
                        model: null,
                        reasoningEffort: null,
                        agentsStates: {
                            [childSessionId]: {status: "interrupted", message: null},
                            [failedChildSessionId]: {status: "errored", message: null},
                        },
                    },
                },
            },
            compactionCompleted(compactionId, childSessionId, childTurnId),
            compactionCompleted(compactionId, failedChildSessionId, childTurnId),
        ]);

        await expect(nativeCompactionLifecycleDump(fixture)).toMatchFileSnapshot(
            "data/session-compaction-native-child-collaboration-terminal.json",
        );
    });

    it.each(["timer", "elapsed deadline"] as const)("settles a native child compaction before timeout closes the child via %s", async (timeoutPath) => {
        vi.useFakeTimers();
        try {
            const fixture = await createNativeChildFixture();
            const siblingSessionId = "timeout-wakeup-child";
            if (timeoutPath === "elapsed deadline") {
                await sendNotifications(fixture, [nativeChildActivityStarted(siblingSessionId)]);
            }
            const prompt = fixture.getCodexAcpAgent().prompt({
                sessionId,
                prompt: [{type: "text", text: "Wait for the delegated task."}],
            });
            await vi.advanceTimersByTimeAsync(0);
            fixture.clearAcpConnectionDump();
            await sendNotifications(fixture, [compactionStarted(compactionId, childSessionId, childTurnId)]);

            if (timeoutPath === "elapsed deadline") {
                // Wake the pending wait after its deadline without firing the timeout timer.
                vi.setSystemTime(Date.now() + 10 * 60 * 1000);
                await sendNotifications(fixture, [{
                    method: "turn/completed",
                    params: {threadId: siblingSessionId, turn: createTurn("completed")},
                }]);
            }
            else {
                await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            }
            await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
            await sendNotifications(fixture, [compactionCompleted(compactionId, childSessionId, childTurnId)]);

            await expect(nativeCompactionLifecycleDump(fixture, childSessionId)).toMatchFileSnapshot(
                "data/session-compaction-native-child-timeout.json",
            );
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each(["failed", "interrupted"] as const)("settles an unfinished compaction when its turn is %s", async (status) => {
        const fixture = await createFixture();
        const turn = createTurn(status);
        if (status === "failed") {
            turn.error = {
                message: "The compaction request failed.",
                codexErrorInfo: null,
                additionalDetails: null,
                misalignment: null,
            };
        }
        await sendNotifications(fixture, [
            compactionStarted(),
            {method: "turn/completed", params: {threadId: sessionId, turn}},
            {method: "turn/completed", params: {threadId: sessionId, turn}},
            compactionCompleted(),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            `data/session-compaction-${status}.json`,
        );
    });

    it("does not settle a compaction when a different turn finishes", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [
            compactionStarted(),
            {
                method: "turn/completed",
                params: {threadId: sessionId, turn: {...createTurn("interrupted"), id: "previous-turn"}},
            },
            compactionCompleted(),
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-deduplicated.json",
        );
    });

    it.each([false, true])("settles a terminal error exactly once with typed failures %s", async (typedFailures) => {
        const fixture = await createFixture({
            ...compactionCapabilities,
            ...(typedFailures ? {
                _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}},
            } : {}),
        });
        await sendNotifications(fixture, [compactionStarted(), compactionError(false), compactionCompleted()]);

        await expect(compactionUpdatesDump(fixture)).toMatchFileSnapshot(
            "data/session-compaction-error.json",
        );
    });

    it("keeps a compaction in progress while Codex retries its request", async () => {
        const fixture = await createFixture();
        await sendNotifications(fixture, [compactionStarted(), compactionError(true), compactionCompleted()]);

        await expect(compactionUpdatesDump(fixture)).toMatchFileSnapshot(
            "data/session-compaction-retried.json",
        );
    });

    it.each([
        ["missing session", {}],
        ["null session", {session: null}],
        ["missing compaction", {session: {}}],
        ["null compaction", {session: {compaction: null}}],
    ] as const)("preserves the existing v1 fallback with %s", async (_name, capabilities) => {
        const fixture = await createFixture(capabilities);
        await sendNotifications(fixture, [
            compactionStarted(),
            compactionCompleted(),
            {method: "thread/compacted", params: {threadId: sessionId, turnId}},
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/session-compaction-legacy.json",
        );
    });

    it("replays a completed boundary between its neighboring messages", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const model = createTestModel();
        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(appServer, "listModels").mockResolvedValue({data: [model], nextCursor: null});
        const thread = createThread([
            agentMessage("before-message", "Before compaction."),
            {type: "contextCompaction", id: compactionId},
            agentMessage("after-message", "After compaction."),
        ]);
        vi.spyOn(appServer, "threadResume").mockResolvedValue({
            thread,
            model: model.id,
            modelProvider: "openai",
            serviceTier: null,
            cwd: thread.cwd,
            instructionSources: [],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
            turnsBackwardsCursor: null,
            itemsBackwardsCursor: null,
        });
        vi.spyOn(appServer, "threadReadWithHistory").mockResolvedValue({thread});
        await agent.initialize({protocolVersion: 1, clientCapabilities: compactionCapabilities});
        await agent.loadSession({sessionId, cwd: thread.cwd, mcpServers: []});

        const timelineUpdates = fixture.getAcpConnectionEvents([]).filter(event =>
            event.method === "sessionUpdate"
            && ["agent_message_chunk", "tool_call", "tool_call_update", "compaction_update", "compaction_summary_chunk"]
                .includes(event.args[0].update.sessionUpdate),
        );
        await expect(JSON.stringify(timelineUpdates, null, 2)).toMatchFileSnapshot(
            "data/session-compaction-replay.json",
        );
    });

    it("negotiates the standard capability and delivers lifecycle updates through the ACP SDK", async () => {
        const mocks = createMockConnections();
        const appServer = new CodexAppServerClient(mocks.mockCodexConnection);
        const codexClient = new CodexAcpClient(appServer);
        vi.spyOn(appServer, "initialize").mockResolvedValue({codexHome: null} as never);
        vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: createTurn("inProgress")});
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("completed"),
        });
        const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
        const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
        const updates: acp.SessionNotification[] = [];
        let server!: CodexAcpServer;
        const client = new acp.ClientSideConnection(
            () => ({
                requestPermission: () => ({outcome: {outcome: "cancelled" as const}}),
                sessionUpdate: (notification) => { updates.push(notification); },
            }),
            acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
        );
        new acp.AgentSideConnection(
            connection => {
                server = new CodexAcpServer(connection, codexClient, undefined, () => null);
                return server;
            },
            acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
        );
        await client.initialize({protocolVersion: 1, clientCapabilities: compactionCapabilities});
        vi.spyOn(server, "getSessionState").mockReturnValue(createTestSessionState({sessionId}));
        await client.prompt({sessionId, prompt: [{type: "text", text: "Continue."}]});
        updates.splice(0);
        mocks.getUnhandledNotificationHandler()!(compactionStarted());
        mocks.getUnhandledNotificationHandler()!(compactionCompleted());
        await codexClient.waitForSessionNotifications(sessionId);
        await vi.waitFor(() => expect(updates).toHaveLength(2));

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot(
            "data/session-compaction-wire.json",
        );
    });
});

async function createFixture(clientCapabilities: acp.ClientCapabilities = compactionCapabilities, nativeSubagents = false) {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const appServer = fixture.getCodexAppServerClient();
    vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: createTurn("inProgress")});
    vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
        threadId: sessionId,
        turn: createTurn("completed"),
    });
    const sessionState = createTestSessionState({sessionId});
    if (nativeSubagents) {
        sessionState.subagents = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(fixture.getAcpConnection(), sessionId),
        );
    }
    vi.spyOn(agent, "getSessionState").mockReturnValue(sessionState);
    await agent.initialize({protocolVersion: 1, clientCapabilities});
    await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue."}]});
    fixture.clearAcpConnectionDump();
    return fixture;
}

async function createNativeChildFixture() {
    const fixture = await createFixture({
        ...compactionCapabilities,
        _meta: {jetbrains: {air: {version: 1, capabilities: ["nativeSubagentSessions"]}}},
    }, true);
    await sendNotifications(fixture, [
        {
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId,
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "spawn-compaction-child",
                    tool: "spawnAgent",
                    status: "inProgress",
                    senderThreadId: sessionId,
                    receiverThreadIds: [childSessionId],
                    prompt: "Continue the delegated task.",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {[childSessionId]: {status: "running", message: null}},
                },
            },
        },
        {
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId,
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "activity-compaction-child",
                    kind: "started",
                    agentThreadId: childSessionId,
                    agentPath: "/root/compaction_child",
                },
            },
        },
    ]);
    return fixture;
}

async function sendNotifications(fixture: CodexMockTestFixture, notifications: ServerNotification[]) {
    for (const notification of notifications) {
        fixture.sendServerNotification(notification);
    }
    await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
}

function compactionStarted(id = compactionId, threadId = sessionId, activeTurnId = turnId): ServerNotification {
    return {
        method: "item/started",
        params: {threadId, turnId: activeTurnId, startedAtMs: 0, item: {type: "contextCompaction", id}},
    };
}

function nativeChildActivityStarted(threadId: string): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId: sessionId,
            turnId,
            startedAtMs: 0,
            item: {
                type: "subAgentActivity",
                id: `activity-${threadId}`,
                kind: "started",
                agentThreadId: threadId,
                agentPath: `/root/${threadId}`,
            },
        },
    };
}

function compactionCompleted(id = compactionId, threadId = sessionId, activeTurnId = turnId): ServerNotification {
    return {
        method: "item/completed",
        params: {threadId, turnId: activeTurnId, completedAtMs: 1, item: {type: "contextCompaction", id}},
    };
}

function compactionError(willRetry: boolean): ServerNotification {
    return {
        method: "error",
        params: {
            threadId: sessionId,
            turnId,
            willRetry,
            error: {
                message: "The compaction request failed.",
                codexErrorInfo: null,
                additionalDetails: null,
                misalignment: null,
            },
        },
    };
}

function compactionUpdatesDump(fixture: CodexMockTestFixture): string {
    return JSON.stringify(fixture.getAcpConnectionEvents([]).filter(event =>
        event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "compaction_update",
    ), null, 2);
}

function nativeCompactionLifecycleDump(fixture: CodexMockTestFixture, childId?: string): string {
    return JSON.stringify(fixture.getAcpConnectionEvents([]).filter(event => {
        if (event.method !== "sessionUpdate") return false;
        const {sessionId: updateSessionId, update} = event.args[0];
        return (update.sessionUpdate === "compaction_update" && (!childId || updateSessionId === childId))
            || (update.sessionUpdate === "subagent_state_update" && (!childId || update.subagentSessionId === childId));
    }), null, 2);
}

function createTurn(status: Turn["status"]): Turn {
    return {
        id: turnId,
        items: [],
        itemsView: "full",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function agentMessage(id: string, text: string): ThreadItem {
    return {type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null};
}

function createThread(items: ThreadItem[]): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "Compaction history",
        ephemeral: false,
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 1,
        updatedAt: 2,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd: "/test/cwd",
        cliVersion: "0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [{...createTurn("completed"), items}],
    };
}
