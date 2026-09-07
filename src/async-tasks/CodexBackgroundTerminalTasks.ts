import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {
    AIR_ASYNC_TASKS_BACKGROUNDED_KEY,
    AIR_ASYNC_TASKS_KEY,
    AIR_META_KEY,
    JETBRAINS_META_KEY,
} from "../AirExtension";
import {logger} from "../Logger";
import type {ThreadBackgroundTerminal} from "./BackgroundTerminalApi";

type CommandExecutionItem = Extract<ThreadItem, {type: "commandExecution"}>;
type TerminalState = "completed" | "failed" | "stopped";

type Task = {
    threadId: string;
    sessionId: string;
    asyncTaskId: string;
    processId: string;
    itemId: string;
    name: string;
    publication: "unpublished" | "publishing" | "published";
    announcement: Promise<void> | null;
    terminalUpdate: Promise<void> | null;
    terminalPublished: boolean;
    state: "running" | "stopping" | TerminalState;
};

type PendingSync = {
    requested: boolean;
    sessionId: string;
    promise: Promise<void>;
};

type TerminalSnapshot = {
    generation: number;
    terminals: ThreadBackgroundTerminal[];
};

/** Maps Codex-owned background terminals to the AIR async task extension. */
export class CodexBackgroundTerminalTasks {
    private readonly tasks = new Map<string, Task>();
    private readonly syncs = new Map<string, PendingSync>();
    private appServerGeneration = 0;
    private appServerQueriesEnabled = true;
    private disposed = false;

    constructor(
        readonly enabled: boolean,
        private readonly rootSessionId: string,
        private appServer: CodexAppServerClient,
        private readonly session: ACPSessionConnection,
    ) {}

    async handleNotification(
        notification: ServerNotification,
        sessionId: string,
        commandTitle?: string,
    ): Promise<void> {
        if (!this.isActive()) return;
        const threadId = notificationThreadId(notification);
        if (threadId === null) return;

        if (notification.method === "item/started" && notification.params.item.type === "commandExecution") {
            this.observeCommandStarted(notification.params.item, threadId, sessionId, commandTitle);
            return;
        }
        if (notification.method === "item/completed" && notification.params.item.type === "commandExecution") {
            await this.observeCommandCompleted(notification.params.item, threadId);
            return;
        }
        if (notification.method === "turn/completed") {
            await this.reconcile(threadId, sessionId);
            return;
        }
        if (notification.method === "item/started") {
            this.refresh(threadId, sessionId);
        }
    }

    private observeCommandStarted(
        item: CommandExecutionItem,
        threadId: string,
        sessionId: string,
        commandTitle?: string,
    ): void {
        if (!this.isActive() || item.processId === null) return;
        this.remember(threadId, sessionId, {
            itemId: item.id,
            processId: item.processId,
            command: item.command,
        }, commandTitle);
    }

    private async observeCommandCompleted(
        item: CommandExecutionItem,
        threadId: string,
    ): Promise<void> {
        if (!this.isActive()) return;
        const task = this.tasks.get(wireTaskId(this.rootSessionId, threadId, item.id));
        if (task) await this.finish(task, item.status === "completed" ? "completed" : "failed");
    }

    refresh(threadId: string = this.rootSessionId, sessionId: string = this.rootSessionId): void {
        void this.reconcile(threadId, sessionId);
    }

    async reconcile(threadId: string = this.rootSessionId, sessionId: string = this.rootSessionId): Promise<void> {
        try {
            await this.sync(threadId, sessionId);
        } catch (error) {
            if (this.isActive()) logger.error(`Failed to list background terminals for ${threadId}`, error);
        }
    }

    setAppServer(appServer: CodexAppServerClient): void {
        this.appServer = appServer;
        this.appServerGeneration += 1;
        this.appServerQueriesEnabled = true;
    }

    prepareForAppServerReplacement(): void {
        this.appServerGeneration += 1;
        this.appServerQueriesEnabled = false;
    }

    async recover(threadId: string, sessionId: string, itemIds: ReadonlySet<string>): Promise<void> {
        if (!this.canQueryAppServer() || itemIds.size === 0) return;
        const snapshot = await this.listAll(threadId);
        if (snapshot === null) return;
        for (const terminal of snapshot.terminals) {
            if (!this.queryIsCurrent(snapshot.generation)) return;
            if (!itemIds.has(terminal.itemId)) continue;
            const task = this.remember(threadId, sessionId, terminal);
            if (task.publication === "unpublished" && task.state === "running") await this.announce(task);
        }
    }

    async finishAll(state: TerminalState): Promise<void> {
        if (!this.isActive()) return;
        const errors: unknown[] = [];
        for (const task of this.tasks.values()) {
            try {
                await this.finish(task, state);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, `Failed to finish ${errors.length} background terminal task(s)`);
        }
    }

    async sync(
        threadId: string = this.rootSessionId,
        sessionId: string = this.rootSessionId,
    ): Promise<void> {
        if (!this.canQueryAppServer()) return;
        const current = this.syncs.get(threadId);
        if (current) {
            current.requested = true;
            current.sessionId = sessionId;
            return await current.promise;
        }

        const pending: PendingSync = {
            requested: false,
            sessionId,
            promise: Promise.resolve(),
        };
        pending.promise = this.syncUntilCurrent(threadId, pending).finally(() => {
            if (this.syncs.get(threadId) === pending) this.syncs.delete(threadId);
        });
        this.syncs.set(threadId, pending);
        await pending.promise;
    }

    async stop(taskId: string): Promise<boolean> {
        if (!this.isActive()) return false;
        const task = this.tasks.get(taskId);
        if (!task || task.publication !== "published") return false;
        if (task.state === "stopped" && !task.terminalPublished) {
            await this.publishTerminalState(task);
            return true;
        }
        if (task.state !== "running") return false;
        task.state = "stopping";
        try {
            const response = await this.appServer.threadBackgroundTerminalsTerminate({
                threadId: task.threadId,
                processId: task.processId,
            });
            if (!response.terminated) {
                if (task.state === "stopping") task.state = "running";
                return false;
            }
            await this.finish(task, "stopped");
            return true;
        } catch (error) {
            if (task.state === "stopping") task.state = "running";
            throw error;
        }
    }

    clear(): void {
        this.disposed = true;
        this.appServerGeneration += 1;
        this.appServerQueriesEnabled = false;
        this.tasks.clear();
        this.syncs.clear();
    }

    private async syncThread(threadId: string, sessionId: string): Promise<void> {
        const snapshot = await this.listAll(threadId);
        if (snapshot === null || !this.queryIsCurrent(snapshot.generation)) return;

        const liveTaskIds = new Set<string>();
        for (const terminal of snapshot.terminals) {
            if (!this.queryIsCurrent(snapshot.generation)) return;
            liveTaskIds.add(terminal.itemId);
            const task = this.remember(threadId, sessionId, terminal);
            if (task.publication === "unpublished" && task.state === "running") await this.announce(task);
        }

        for (const task of this.tasks.values()) {
            if (!this.queryIsCurrent(snapshot.generation)) return;
            if (task.threadId === threadId
                && task.publication === "published"
                && (task.state === "running" || task.state === "stopping")
                && !liveTaskIds.has(task.itemId)) {
                await this.finish(task, "stopped");
            }
        }
    }

    private async syncUntilCurrent(threadId: string, pending: PendingSync): Promise<void> {
        let hasFailure = false;
        let failure: unknown;
        do {
            pending.requested = false;
            try {
                await this.syncThread(threadId, pending.sessionId);
                hasFailure = false;
            } catch (error) {
                hasFailure = true;
                failure = error;
            }
        } while (pending.requested && this.canQueryAppServer());
        if (hasFailure) throw failure;
    }

    private async announce(task: Task): Promise<void> {
        if (task.publication === "published") return;
        if (task.announcement !== null) {
            await task.announcement;
            return;
        }

        task.publication = "publishing";
        const announcement = this.publishAnnouncement(task);
        task.announcement = announcement;
        try {
            await announcement;
        } finally {
            if (task.announcement === announcement) task.announcement = null;
        }
        if (isTerminalState(task.state)) await this.publishTerminalState(task);
    }

    private async publishAnnouncement(task: Task): Promise<void> {
        try {
            await this.publishSpawn(task);
            task.publication = "published";
        } catch (error) {
            task.publication = "unpublished";
            throw error;
        }
    }

    private async publishSpawn(task: Task): Promise<void> {
        await this.session.update({
            sessionUpdate: "tool_call_update",
            toolCallId: task.itemId,
            _meta: {
                [JETBRAINS_META_KEY]: {
                    [AIR_META_KEY]: {
                        [AIR_ASYNC_TASKS_KEY]: {
                            [AIR_ASYNC_TASKS_BACKGROUNDED_KEY]: true,
                        },
                    },
                },
            },
        }, task.sessionId);
        await this.session.update({
            sessionUpdate: "async_task_spawned",
            asyncTaskId: task.asyncTaskId,
            name: task.name,
            taskType: "shell",
            showInTranscript: false,
            canStop: true,
            toolCallId: task.itemId,
        }, task.sessionId);
    }

    private remember(
        threadId: string,
        sessionId: string,
        terminal: ThreadBackgroundTerminal,
        commandTitle?: string,
    ): Task {
        const asyncTaskId = wireTaskId(this.rootSessionId, threadId, terminal.itemId);
        const existing = this.tasks.get(asyncTaskId);
        if (existing) {
            existing.processId = terminal.processId;
            if (commandTitle !== undefined) existing.name = commandTitle;
            return existing;
        }
        const task: Task = {
            threadId,
            sessionId,
            asyncTaskId,
            processId: terminal.processId,
            itemId: terminal.itemId,
            name: commandTitle ?? terminal.command,
            publication: "unpublished",
            announcement: null,
            terminalUpdate: null,
            terminalPublished: false,
            state: "running",
        };
        this.tasks.set(asyncTaskId, task);
        return task;
    }

    private async finish(task: Task, state: TerminalState): Promise<void> {
        if (task.state === "running" || task.state === "stopping") {
            task.state = state;
        } else if (task.state !== state) {
            return;
        }
        if (task.announcement !== null) await task.announcement;
        if (task.publication === "published") await this.publishTerminalState(task);
    }

    private async publishTerminalState(task: Task): Promise<void> {
        if (!isTerminalState(task.state) || task.terminalPublished) return;
        if (task.terminalUpdate !== null) {
            await task.terminalUpdate;
            return;
        }
        const terminalUpdate = this.session.update({
            sessionUpdate: "async_task_state_update",
            asyncTaskId: task.asyncTaskId,
            state: task.state,
            toolCallId: task.itemId,
        }, task.sessionId);
        task.terminalUpdate = terminalUpdate;
        try {
            await terminalUpdate;
            task.terminalPublished = true;
        } finally {
            if (task.terminalUpdate === terminalUpdate) task.terminalUpdate = null;
        }
    }

    private async listAll(threadId: string): Promise<TerminalSnapshot | null> {
        const appServer = this.appServer;
        const generation = this.appServerGeneration;
        const terminals: ThreadBackgroundTerminal[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const response = await appServer.threadBackgroundTerminalsList({
                threadId,
                cursor,
            });
            if (!this.queryIsCurrent(generation)) return null;
            terminals.push(...response.data);
            cursor = response.nextCursor;
            if (cursor !== null) {
                if (seenCursors.has(cursor)) {
                    throw new Error("Codex returned a repeated background terminal cursor");
                }
                seenCursors.add(cursor);
            }
        } while (cursor !== null);
        return {generation, terminals};
    }

    private isActive(): boolean {
        return this.enabled && !this.disposed;
    }

    private canQueryAppServer(): boolean {
        return this.isActive() && this.appServerQueriesEnabled;
    }

    private queryIsCurrent(generation: number): boolean {
        return this.canQueryAppServer() && generation === this.appServerGeneration;
    }
}

function isTerminalState(state: Task["state"]): state is TerminalState {
    return state === "completed" || state === "failed" || state === "stopped";
}

function wireTaskId(rootSessionId: string, threadId: string, itemId: string): string {
    return threadId === rootSessionId ? itemId : `${threadId}:${itemId}`;
}

function notificationThreadId(notification: ServerNotification): string | null {
    const threadId = (notification.params as {threadId?: unknown}).threadId;
    return typeof threadId === "string" ? threadId : null;
}
