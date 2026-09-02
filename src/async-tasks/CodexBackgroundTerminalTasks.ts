import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import type {CodexAppServerClient} from "../CodexAppServerClient";
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
    command: string;
    announced: boolean;
    state: "running" | "stopping" | TerminalState;
};

type PendingSync = {
    requested: boolean;
    sessionId: string;
    promise: Promise<void>;
};

/** Maps Codex-owned background terminals to the AIR async task extension. */
export class CodexBackgroundTerminalTasks {
    private readonly tasks = new Map<string, Task>();
    private readonly syncs = new Map<string, PendingSync>();
    private disposed = false;

    constructor(
        readonly enabled: boolean,
        private readonly rootSessionId: string,
        private readonly appServer: CodexAppServerClient,
        private readonly session: ACPSessionConnection,
    ) {}

    async handleNotification(notification: ServerNotification, sessionId: string): Promise<void> {
        if (!this.isActive()) return;
        const threadId = notificationThreadId(notification);
        if (threadId === null) return;

        if (notification.method === "item/started" && notification.params.item.type === "commandExecution") {
            this.observeCommandStarted(notification.params.item, threadId, sessionId);
            return;
        }
        if (notification.method === "item/completed" && notification.params.item.type === "commandExecution") {
            await this.observeCommandCompleted(notification.params.item, threadId);
            return;
        }
        if (notification.method === "item/started" || notification.method === "turn/completed") {
            this.refresh(threadId, sessionId);
        }
    }

    private observeCommandStarted(
        item: CommandExecutionItem,
        threadId: string,
        sessionId: string,
    ): void {
        if (!this.isActive() || item.processId === null) return;
        this.remember(threadId, sessionId, {
            itemId: item.id,
            processId: item.processId,
            command: item.command,
        });
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
        void this.sync(threadId, sessionId).catch((error) => {
            if (this.isActive()) logger.error(`Failed to list background terminals for ${threadId}`, error);
        });
    }

    async sync(
        threadId: string = this.rootSessionId,
        sessionId: string = this.rootSessionId,
    ): Promise<void> {
        if (!this.isActive()) return;
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
        if (!task || !task.announced || task.state !== "running") return false;
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
        this.tasks.clear();
        this.syncs.clear();
    }

    private async syncThread(threadId: string, sessionId: string): Promise<void> {
        const terminals = await this.listAll(threadId);
        if (!this.isActive()) return;

        const liveTaskIds = new Set<string>();
        for (const terminal of terminals) {
            if (!this.isActive()) return;
            liveTaskIds.add(terminal.itemId);
            const task = this.remember(threadId, sessionId, terminal);
            if (!task.announced && task.state === "running") await this.announce(task);
        }

        for (const task of this.tasks.values()) {
            if (task.threadId === threadId
                && task.announced
                && (task.state === "running" || task.state === "stopping")
                && !liveTaskIds.has(task.itemId)) {
                await this.finish(task, "stopped");
            }
        }
    }

    private async syncUntilCurrent(threadId: string, pending: PendingSync): Promise<void> {
        do {
            pending.requested = false;
            await this.syncThread(threadId, pending.sessionId);
        } while (pending.requested && this.isActive());
    }

    private async announce(task: Task): Promise<void> {
        task.announced = true;
        try {
            await this.session.update({
                sessionUpdate: "async_task_spawned",
                asyncTaskId: task.asyncTaskId,
                name: task.command,
                taskType: "shell",
                description: task.command,
                showInTranscript: false,
                canStop: true,
                toolCallId: task.itemId,
            }, task.sessionId);
        } catch (error) {
            task.announced = false;
            throw error;
        }
    }

    private remember(
        threadId: string,
        sessionId: string,
        terminal: ThreadBackgroundTerminal,
    ): Task {
        const asyncTaskId = wireTaskId(this.rootSessionId, threadId, terminal.itemId);
        const existing = this.tasks.get(asyncTaskId);
        if (existing) {
            existing.processId = terminal.processId;
            return existing;
        }
        const task: Task = {
            threadId,
            sessionId,
            asyncTaskId,
            processId: terminal.processId,
            itemId: terminal.itemId,
            command: terminal.command,
            announced: false,
            state: "running",
        };
        this.tasks.set(asyncTaskId, task);
        return task;
    }

    private async finish(task: Task, state: TerminalState): Promise<void> {
        if (task.state !== "running" && task.state !== "stopping") return;
        const previousState = task.state;
        task.state = state;
        if (!task.announced) return;

        try {
            await this.session.update({
                sessionUpdate: "async_task_state_update",
                asyncTaskId: task.asyncTaskId,
                state,
                toolCallId: task.itemId,
            }, task.sessionId);
        } catch (error) {
            if (task.state === state) task.state = previousState;
            throw error;
        }
    }

    private async listAll(threadId: string): Promise<ThreadBackgroundTerminal[]> {
        const terminals: ThreadBackgroundTerminal[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const response = await this.appServer.threadBackgroundTerminalsList({
                threadId,
                cursor,
            });
            terminals.push(...response.data);
            cursor = response.nextCursor;
            if (cursor !== null) {
                if (seenCursors.has(cursor)) {
                    throw new Error("Codex returned a repeated background terminal cursor");
                }
                seenCursors.add(cursor);
            }
        } while (cursor !== null);
        return terminals;
    }

    private isActive(): boolean {
        return this.enabled && !this.disposed;
    }
}

function wireTaskId(rootSessionId: string, threadId: string, itemId: string): string {
    return threadId === rootSessionId ? itemId : `${threadId}:${itemId}`;
}

function notificationThreadId(notification: ServerNotification): string | null {
    const threadId = (notification.params as {threadId?: unknown}).threadId;
    return typeof threadId === "string" ? threadId : null;
}
