import {describe, expect, it, vi} from "vitest";
import type {ThreadItem} from "../../app-server/v2";
import {ACPSessionConnection, type UpdateSessionEvent} from "../../ACPSessionConnection";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexBackgroundTerminalTasks} from "../../async-tasks/CodexBackgroundTerminalTasks";
import {ASYNC_TASK_STOP_METHOD} from "../../async-tasks/AsyncTaskExtension";
import {CodexSubagentEventRouter} from "../../subagents/CodexSubagentEventRouter";
import type {
    ThreadBackgroundTerminal,
    ThreadBackgroundTerminalsListResponse,
} from "../../async-tasks/BackgroundTerminalApi";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
} from "../acp-test-utils";

type CommandExecutionItem = Extract<ThreadItem, {type: "commandExecution"}>;

describe("Codex background terminal tasks", () => {
    it("discovers background work from the root session event stream", async () => {
        const fixture = createCodexMockTestFixture();
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: 1,
            clientCapabilities: {
                _meta: {jetbrains: {air: {version: 1, capabilities: ["asyncTasks"]}}},
            },
        });
        const sessionState = createTestSessionState({sessionId: "thread-1"});
        sessionState.asyncTasks = new CodexBackgroundTerminalTasks(
            true,
            sessionState.sessionId,
            fixture.getCodexAppServerClient(),
            new ACPSessionConnection(fixture.getAcpConnection(), sessionState.sessionId),
        );
        // @ts-expect-error - register the local session for session-generation checks
        fixture.getCodexAcpAgent().sessions.set(sessionState.sessionId, sessionState);
        vi.spyOn(fixture.getCodexAppServerClient(), "threadBackgroundTerminalsList")
            .mockResolvedValue(page([terminal()]));

        await setupPromptAndSendNotifications(fixture, sessionState.sessionId, sessionState, [
            started(command()),
            started({type: "reasoning", id: "reasoning-1", summary: [], content: []}),
        ]);

        await vi.waitFor(() => {
            const taskUpdates = fixture.getAcpConnectionEvents([])
                .filter(event => event.method === "sessionUpdate")
                .map(event => event.args[0].update)
                .filter(update => update.sessionUpdate === "async_task_spawned");
            expect(taskUpdates).toEqual([expect.objectContaining({
                asyncTaskId: "command-1",
                toolCallId: "command-1",
            })]);
        });
    });

    it("publishes a background terminal as a task linked to its command", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([terminal()]));

        await fixture.tasks.handleNotification(started(command()), "thread-1");
        await fixture.tasks.sync();

        expect(fixture.updates).toEqual([{
            sessionUpdate: "async_task_spawned",
            asyncTaskId: "command-1",
            name: "python -m http.server",
            taskType: "shell",
            description: "python -m http.server",
            showInTranscript: false,
            canStop: true,
            toolCallId: "command-1",
        }]);
    });

    it("does not publish a command that completes before it becomes background work", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([]));
        const item = command();

        await fixture.tasks.handleNotification(started(item), "thread-1");
        await fixture.tasks.handleNotification(completed({...item, status: "completed", exitCode: 0}), "thread-1");
        await fixture.tasks.sync();

        expect(fixture.updates).toEqual([]);
    });

    it("publishes the terminal state after a background command exits", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([terminal()]));
        const item = command();

        await fixture.tasks.handleNotification(started(item), "thread-1");
        await fixture.tasks.sync();
        await fixture.tasks.handleNotification(completed({...item, status: "failed", exitCode: 1}), "thread-1");

        expect(fixture.updates.at(-1)).toEqual({
            sessionUpdate: "async_task_state_update",
            asyncTaskId: "command-1",
            state: "failed",
            toolCallId: "command-1",
        });
    });

    it("retries a terminal update that the client rejected", async () => {
        let rejectTerminalUpdate = true;
        const fixture = createFixture(true, async update => {
            if (update.sessionUpdate === "async_task_state_update" && rejectTerminalUpdate) {
                rejectTerminalUpdate = false;
                throw new Error("client disconnected");
            }
        });
        fixture.list.mockResolvedValue(page([terminal()]));
        const completedItem = {...command(), status: "completed" as const, exitCode: 0};
        await fixture.tasks.sync();

        await expect(fixture.tasks.handleNotification(completed(completedItem), "thread-1"))
            .rejects.toThrow("client disconnected");
        await expect(fixture.tasks.handleNotification(completed(completedItem), "thread-1"))
            .resolves.toBeUndefined();

        expect(fixture.updates.filter(update => update.sessionUpdate === "async_task_state_update"))
            .toEqual([expect.objectContaining({state: "completed"})]);
    });

    it("finishes an announced task that disappears from the live terminal list", async () => {
        const fixture = createFixture();
        fixture.list
            .mockResolvedValueOnce(page([terminal()]))
            .mockResolvedValueOnce(page([]));

        await fixture.tasks.sync();
        await fixture.tasks.sync();

        expect(fixture.updates.at(-1)).toEqual({
            sessionUpdate: "async_task_state_update",
            asyncTaskId: "command-1",
            state: "stopped",
            toolCallId: "command-1",
        });
    });

    it("stops one task through the app-server process id", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([terminal()]));
        fixture.terminate.mockResolvedValue({terminated: true});
        await fixture.tasks.sync();

        await expect(fixture.tasks.stop("command-1")).resolves.toBe(true);

        expect(fixture.terminate).toHaveBeenCalledWith({
            threadId: "thread-1",
            processId: "42",
        });
        expect(fixture.updates.at(-1)).toEqual({
            sessionUpdate: "async_task_state_update",
            asyncTaskId: "command-1",
            state: "stopped",
            toolCallId: "command-1",
        });
        await expect(fixture.tasks.stop("command-1")).resolves.toBe(false);
    });

    it("keeps a task stoppable when termination is rejected or fails", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([terminal()]));
        fixture.terminate
            .mockResolvedValueOnce({terminated: false})
            .mockRejectedValueOnce(new Error("terminate failed"))
            .mockResolvedValueOnce({terminated: true});
        await fixture.tasks.sync();

        await expect(fixture.tasks.stop("command-1")).resolves.toBe(false);
        await expect(fixture.tasks.stop("command-1")).rejects.toThrow("terminate failed");
        await expect(fixture.tasks.stop("command-1")).resolves.toBe(true);

        expect(fixture.terminate).toHaveBeenCalledTimes(3);
    });

    it("keeps a task stoppable when its stopped update fails", async () => {
        let rejectStoppedUpdate = true;
        const fixture = createFixture(true, async update => {
            if (update.sessionUpdate === "async_task_state_update" && rejectStoppedUpdate) {
                rejectStoppedUpdate = false;
                throw new Error("client disconnected");
            }
        });
        fixture.list.mockResolvedValue(page([terminal()]));
        fixture.terminate.mockResolvedValue({terminated: true});
        await fixture.tasks.sync();

        await expect(fixture.tasks.stop("command-1")).rejects.toThrow("client disconnected");
        await expect(fixture.tasks.stop("command-1")).resolves.toBe(true);

        expect(fixture.terminate).toHaveBeenCalledTimes(2);
        expect(fixture.updates.filter(update => update.sessionUpdate === "async_task_state_update"))
            .toEqual([expect.objectContaining({state: "stopped"})]);
    });

    it("does not overwrite completion that races with a stop request", async () => {
        const fixture = createFixture();
        const termination = deferred<{terminated: boolean}>();
        fixture.list.mockResolvedValue(page([terminal()]));
        fixture.terminate.mockReturnValue(termination.promise);
        await fixture.tasks.sync();

        const stop = fixture.tasks.stop("command-1");
        await fixture.tasks.handleNotification(
            completed({...command(), status: "completed", exitCode: 0}),
            "thread-1",
        );
        termination.resolve({terminated: true});

        await expect(stop).resolves.toBe(true);
        expect(fixture.updates.filter(update => update.sessionUpdate === "async_task_state_update"))
            .toEqual([expect.objectContaining({state: "completed"})]);
    });

    it("routes the AIR stop request to the session task runtime", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState({sessionId: "thread-1"});
        const stop = vi.spyOn(sessionState.asyncTasks, "stop").mockResolvedValue(true);
        // @ts-expect-error - register the local session for the extension request path
        fixture.getCodexAcpAgent().sessions.set(sessionState.sessionId, sessionState);

        await expect(fixture.getCodexAcpAgent().extMethod(ASYNC_TASK_STOP_METHOD, {
            sessionId: sessionState.sessionId,
            asyncTaskId: "command-1",
        })).resolves.toEqual({stopped: true});
        expect(stop).toHaveBeenCalledWith("command-1");
    });

    it("reads every background terminal page", async () => {
        const fixture = createFixture();
        fixture.list
            .mockResolvedValueOnce(page([terminal()], "42"))
            .mockResolvedValueOnce(page([terminal({itemId: "command-2", processId: "84"})]));

        await fixture.tasks.sync();

        expect(fixture.list).toHaveBeenNthCalledWith(1, {
            threadId: "thread-1",
            cursor: null,
        });
        expect(fixture.list).toHaveBeenNthCalledWith(2, {
            threadId: "thread-1",
            cursor: "42",
        });
        expect(fixture.updates).toHaveLength(2);
    });

    it("rejects a repeated background terminal cursor", async () => {
        const fixture = createFixture();
        fixture.list
            .mockResolvedValueOnce(page([], "repeated"))
            .mockResolvedValueOnce(page([], "repeated"));

        await expect(fixture.tasks.sync()).rejects.toThrow("repeated background terminal cursor");

        expect(fixture.list).toHaveBeenCalledTimes(2);
    });

    it("runs a trailing refresh when a list request is already in flight", async () => {
        const fixture = createFixture();
        const listing = deferred<ThreadBackgroundTerminalsListResponse>();
        fixture.list
            .mockReturnValueOnce(listing.promise)
            .mockResolvedValueOnce(page([terminal()]));

        const first = fixture.tasks.sync();
        const second = fixture.tasks.sync();
        listing.resolve(page([terminal()]));
        await Promise.all([first, second]);

        expect(fixture.list).toHaveBeenCalledTimes(2);
        expect(fixture.updates.filter(update => update.sessionUpdate === "async_task_spawned")).toHaveLength(1);
    });

    it("does not publish an in-flight list result after clear", async () => {
        const fixture = createFixture();
        const listing = deferred<ThreadBackgroundTerminalsListResponse>();
        fixture.list.mockReturnValue(listing.promise);

        const sync = fixture.tasks.sync();
        fixture.tasks.clear();
        listing.resolve(page([terminal()]));
        await sync;

        expect(fixture.updates).toEqual([]);
    });

    it("publishes a child terminal on its native subagent session", async () => {
        const fixture = createCodexMockTestFixture();
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: 1,
            clientCapabilities: {
                _meta: {jetbrains: {air: {version: 1, capabilities: ["asyncTasks", "nativeSubagentSessions"]}}},
            },
        });
        const sessionState = createTestSessionState({sessionId: "thread-1"});
        const session = new ACPSessionConnection(fixture.getAcpConnection(), sessionState.sessionId);
        sessionState.subagents = new CodexSubagentEventRouter(sessionState.sessionId, true, session);
        sessionState.asyncTasks = new CodexBackgroundTerminalTasks(
            true,
            sessionState.sessionId,
            fixture.getCodexAppServerClient(),
            session,
        );
        // @ts-expect-error - register the local session for session-generation checks
        fixture.getCodexAcpAgent().sessions.set(sessionState.sessionId, sessionState);
        let childListCount = 0;
        vi.spyOn(fixture.getCodexAppServerClient(), "threadBackgroundTerminalsList")
            .mockImplementation(async params => page(
                params.threadId === "child-1" && childListCount++ === 0 ? [terminal()] : [],
            ));

        await setupPromptAndSendNotifications(fixture, sessionState.sessionId, sessionState, [
            childSpawned(),
            childMaterialized(),
            started(command(), "child-1"),
            started({type: "reasoning", id: "reasoning-1", summary: [], content: []}, "child-1"),
            turnCompleted("child-1"),
        ]);

        await vi.waitFor(() => {
            const spawned = fixture.getAcpConnectionEvents([])
                .filter(event => event.method === "sessionUpdate")
                .map(event => event.args[0])
                .find(event => event.update.sessionUpdate === "async_task_spawned");
            expect(spawned).toMatchObject({
                sessionId: "child-1",
                update: {asyncTaskId: "child-1:command-1", toolCallId: "command-1"},
            });
            const stopped = fixture.getAcpConnectionEvents([])
                .filter(event => event.method === "sessionUpdate")
                .map(event => event.args[0])
                .find(event => event.update.sessionUpdate === "async_task_state_update");
            expect(stopped).toMatchObject({
                sessionId: "child-1",
                update: {asyncTaskId: "child-1:command-1", state: "stopped"},
            });
        });

        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "threadBackgroundTerminalsTerminate")
            .mockResolvedValue({terminated: true});
        await expect(fixture.getCodexAcpAgent().extMethod(ASYNC_TASK_STOP_METHOD, {
            sessionId: sessionState.sessionId,
            asyncTaskId: "child-1:command-1",
        })).resolves.toEqual({stopped: false});
        expect(terminate).not.toHaveBeenCalled();
    });

    it("routes a child task stop to its owning Codex thread", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([terminal()]));
        fixture.terminate.mockResolvedValue({terminated: true});
        await fixture.tasks.handleNotification(started(command(), "child-1"), "child-1");
        await fixture.tasks.sync("child-1", "child-1");

        await expect(fixture.tasks.stop("child-1:command-1")).resolves.toBe(true);

        expect(fixture.terminate).toHaveBeenCalledWith({threadId: "child-1", processId: "42"});
    });

    it("does nothing when the client did not negotiate async tasks", async () => {
        const fixture = createFixture(false);

        await fixture.tasks.handleNotification(started(command()), "thread-1");
        await fixture.tasks.sync();
        await expect(fixture.tasks.stop("command-1")).resolves.toBe(false);

        expect(fixture.list).not.toHaveBeenCalled();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.updates).toEqual([]);
    });
});

function createFixture(
    enabled = true,
    beforeUpdate?: (update: UpdateSessionEvent) => void | Promise<void>,
) {
    const updates: UpdateSessionEvent[] = [];
    const list = vi.fn<() => Promise<ThreadBackgroundTerminalsListResponse>>();
    const terminate = vi.fn();
    const appServer = {
        threadBackgroundTerminalsList: list,
        threadBackgroundTerminalsTerminate: terminate,
    } as unknown as CodexAppServerClient;
    const session = new ACPSessionConnection({
        notify: vi.fn(async (_method, params) => {
            const update = (params as {update: UpdateSessionEvent}).update;
            await beforeUpdate?.(update);
            updates.push(update);
        }),
        request: vi.fn(),
    }, "thread-1");
    return {
        updates,
        list,
        terminate,
        tasks: new CodexBackgroundTerminalTasks(enabled, "thread-1", appServer, session),
    };
}

function terminal(overrides: Partial<ThreadBackgroundTerminal> = {}): ThreadBackgroundTerminal {
    return {
        itemId: "command-1",
        processId: "42",
        command: "python -m http.server",
        ...overrides,
    };
}

function page(data: ThreadBackgroundTerminal[], nextCursor: string | null = null): ThreadBackgroundTerminalsListResponse {
    return {data, nextCursor};
}

function command(): CommandExecutionItem {
    return {
        type: "commandExecution",
        id: "command-1",
        pluginId: null,
        scriptPath: null,
        command: "python -m http.server",
        cwd: "/workspace",
        processId: "42",
        source: "unifiedExecStartup",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
    };
}

function started(item: ThreadItem, threadId = "thread-1") {
    return {
        method: "item/started" as const,
        params: {
            threadId,
            turnId: "turn-id",
            startedAtMs: 0,
            item,
        },
    };
}

function completed(item: ThreadItem, threadId = "thread-1") {
    return {
        method: "item/completed" as const,
        params: {
            threadId,
            turnId: "turn-id",
            completedAtMs: 0,
            item,
        },
    };
}

function turnCompleted(threadId: string) {
    return {
        method: "turn/completed" as const,
        params: {
            threadId,
            turn: {
                id: "turn-id",
                items: [],
                itemsView: "notLoaded" as const,
                status: "completed" as const,
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        },
    };
}

function childSpawned() {
    return started({
        type: "collabAgentToolCall",
        id: "spawn-child",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-1"],
        prompt: "Run a server",
        model: null,
        reasoningEffort: null,
        agentsStates: {"child-1": {status: "running", message: null}},
    });
}

function childMaterialized() {
    return started({
        type: "subAgentActivity",
        id: "child-activity",
        kind: "started",
        agentThreadId: "child-1",
        agentPath: "/root/worker",
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(innerResolve => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}
