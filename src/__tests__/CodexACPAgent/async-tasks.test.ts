import {describe, expect, it, vi} from "vitest";
import type {ThreadItem} from "../../app-server/v2";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexBackgroundTerminalTasks} from "../../async-tasks/CodexBackgroundTerminalTasks";
import {ASYNC_TASK_STOP_METHOD} from "../../async-tasks/AsyncTaskExtension";
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

        fixture.tasks.observeCommandStarted(command());
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

        fixture.tasks.observeCommandStarted(item);
        await fixture.tasks.observeCommandCompleted({...item, status: "completed", exitCode: 0});
        await fixture.tasks.sync();

        expect(fixture.updates).toEqual([]);
    });

    it("publishes the terminal state after a background command exits", async () => {
        const fixture = createFixture();
        fixture.list.mockResolvedValue(page([terminal()]));
        const item = command();

        fixture.tasks.observeCommandStarted(item);
        await fixture.tasks.sync();
        await fixture.tasks.observeCommandCompleted({...item, status: "failed", exitCode: 1});

        expect(fixture.updates.at(-1)).toEqual({
            sessionUpdate: "async_task_state_update",
            asyncTaskId: "command-1",
            state: "failed",
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
            limit: 64,
        });
        expect(fixture.list).toHaveBeenNthCalledWith(2, {
            threadId: "thread-1",
            cursor: "42",
            limit: 64,
        });
        expect(fixture.updates).toHaveLength(2);
    });

    it("does nothing when the client did not negotiate async tasks", async () => {
        const fixture = createFixture(false);

        fixture.tasks.observeCommandStarted(command());
        await fixture.tasks.sync();
        await expect(fixture.tasks.stop("command-1")).resolves.toBe(false);

        expect(fixture.list).not.toHaveBeenCalled();
        expect(fixture.terminate).not.toHaveBeenCalled();
        expect(fixture.updates).toEqual([]);
    });
});

function createFixture(enabled = true) {
    const updates: unknown[] = [];
    const list = vi.fn<() => Promise<ThreadBackgroundTerminalsListResponse>>();
    const terminate = vi.fn();
    const appServer = {
        threadBackgroundTerminalsList: list,
        threadBackgroundTerminalsTerminate: terminate,
    } as unknown as CodexAppServerClient;
    const session = new ACPSessionConnection({
        notify: vi.fn(async (_method, params) => {
            updates.push((params as {update: unknown}).update);
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
        cwd: "/workspace",
        osPid: null,
        cpuPercent: null,
        rssKb: null,
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

function started(item: ThreadItem) {
    return {
        method: "item/started" as const,
        params: {
            threadId: "thread-1",
            turnId: "turn-id",
            startedAtMs: 0,
            item,
        },
    };
}
