import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {stripShellPrefix} from "../CommandUtils";
import {isAbsoluteProtocolPath} from "../PathUtils";
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
    cwd?: string;
    standardPublished: boolean;
    reportedExit: boolean;
    standardSend: Promise<void>;
};

type PendingSync = {
    requested: boolean;
    sessionId: string;
    discover: boolean;
    promise: Promise<void>;
};

type TerminalSnapshot = {
    generation: number;
    terminals: ThreadBackgroundTerminal[];
};

const LIVE_POLL_MS = 1_000;

/** One runtime inventory for the AIR extension and the ACP v2 display terminals. */
export class CodexBackgroundTasks {
    /** The live tasks. A task leaves the map when it ends, so the map holds only the running commands. */
    private readonly tasks = new Map<string, Task>();
    /**
     * The thread of each task that ended while Codex can still list it, for example from a list that started
     * before the end. A task leaves the map when a list of its thread no longer names it.
     */
    private readonly ended = new Map<string, string>();
    private readonly syncs = new Map<string, PendingSync>();
    private appServerGeneration = 0;
    private appServerQueriesEnabled = true;
    private disposed = false;
    private poll: ReturnType<typeof setTimeout> | undefined;

    constructor(
        readonly enabled: boolean,
        private readonly rootSessionId: string,
        private appServer: CodexAppServerClient,
        private readonly session: ACPSessionConnection,
        private readonly standard = false,
        private readonly standardChildren = false,
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
        // The list includes processes still serving their initial tool call. At a turn boundary
        // a surviving process is known to be detached. Publish its terminal before reporting idle.
        if (this.reportsStandard(sessionId) && notification.method === "turn/completed"
            && notification.params.turn.status !== "inProgress") {
            await this.reconcile(threadId, sessionId);
        } else if (this.enabled && (notification.method === "turn/completed"
            || (notification.method === "item/started" && this.hasRunningTask(threadId)))) {
            void this.reconcile(threadId, sessionId, false);
        }
    }

    private observeCommandStarted(
        item: CommandExecutionItem,
        threadId: string,
        sessionId: string,
        commandTitle?: string,
    ): void {
        if (!this.isActive() || item.processId == null) return;
        this.remember(threadId, sessionId, {
            itemId: item.id,
            processId: item.processId,
            command: item.command,
            cwd: item.cwd,
        }, commandTitle);
    }

    private async observeCommandCompleted(
        item: CommandExecutionItem,
        threadId: string,
    ): Promise<void> {
        if (!this.isActive()) return;
        const task = this.tasks.get(wireTaskId(this.rootSessionId, threadId, item.id));
        if (task) {
            // The v2 event handler publishes the regular exit (and any remaining output) first.
            task.reportedExit = this.standard;
            await this.finish(task, item.status === "completed" ? "completed" : "failed");
        }
    }

    refresh(threadId: string = this.rootSessionId, sessionId: string = this.rootSessionId): void {
        void this.reconcile(threadId, sessionId, false);
    }

    async reconcile(threadId: string = this.rootSessionId, sessionId: string = this.rootSessionId, discover = true): Promise<void> {
        try {
            await this.sync(threadId, sessionId, discover);
        } catch (error) {
            if (this.isActive()) logger.error(`Failed to list background terminals for ${threadId}`, error);
        }
    }

    setAppServer(appServer: CodexAppServerClient): void {
        this.appServer = appServer;
        this.appServerGeneration += 1;
        this.appServerQueriesEnabled = true;
    }

    /** Reannounce current entities for a client that did not keep the previous transcript. */
    async snapshot(threadId: string, sessionId: string, discover: boolean): Promise<void> {
        if (!this.reportsStandard(sessionId)) return;
        const seen = [...this.tasks.values()].filter(task => task.threadId === threadId && task.standardPublished);
        await this.reconcile(threadId, sessionId, discover);
        for (const task of seen) {
            await this.publishStandard(task, this.appServerGeneration, true);
        }
    }

    prepareForAppServerReplacement(): void {
        this.appServerGeneration += 1;
        this.appServerQueriesEnabled = false;
        clearTimeout(this.poll);
        this.poll = undefined;
    }

    async recover(threadId: string, sessionId: string, itemIds: ReadonlySet<string>): Promise<void> {
        if (!this.enabled || !this.canQueryAppServer() || itemIds.size === 0) return;
        const snapshot = await this.listAll(threadId);
        if (snapshot === null) return;
        for (const terminal of snapshot.terminals) {
            if (!this.queryIsCurrent(snapshot.generation)) return;
            if (!itemIds.has(terminal.itemId)) continue;
            if (this.ended.has(wireTaskId(this.rootSessionId, threadId, terminal.itemId))) continue;
            const task = this.remember(threadId, sessionId, terminal);
            if (task.publication === "unpublished" && task.state === "running") await this.announce(task);
        }
    }

    async finishAll(state: TerminalState): Promise<void> {
        if (!this.isActive()) return;
        const errors: unknown[] = [];
        for (const task of [...this.tasks.values()]) {
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
        discover = true,
    ): Promise<void> {
        if (!this.canQueryAppServer()) return;
        const current = this.syncs.get(threadId);
        if (current) {
            current.requested = true;
            current.sessionId = sessionId;
            current.discover ||= discover;
            return await current.promise;
        }

        const pending: PendingSync = {
            requested: false,
            sessionId,
            discover,
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
        if (!task) return false;
        if (this.standard) return this.cancelTerminal(task.sessionId, task.itemId);
        if (task.publication !== "published") return false;
        return this.stopTask(task);
    }

    async cancelTerminal(sessionId: string, terminalId: string): Promise<boolean> {
        const task = [...this.tasks.values()].find(task => task.sessionId === sessionId && task.itemId === terminalId);
        if (!task) return false;
        await task.standardSend;
        return task.standardPublished && await this.stopTask(task, true);
    }

    private async stopTask(task: Task, verifyLive = false): Promise<boolean> {
        if (!this.canQueryAppServer()) return false;
        if (!verifyLive && task.state === "stopped" && !task.terminalPublished) {
            await this.finish(task, "stopped");
            return true;
        }
        if (task.state !== "running") return false;
        task.state = "stopping";
        const generation = this.appServerGeneration;
        const processId = task.processId;
        try {
            if (verifyLive) {
                // Codex can accept termination for an exited process that still holds pipes.
                // Check that this item still owns the live handle before asking Codex to stop it.
                const snapshot = await this.listAll(task.threadId);
                if (snapshot === null || task.state !== "stopping" || this.tasks.get(task.asyncTaskId) !== task) return false;
                if (task.processId !== processId) return false;
                if (!snapshot.terminals.some(entry => entry.itemId === task.itemId && entry.processId === processId)) {
                    await this.finish(task, "stopped");
                    return false;
                }
            }
            const response = await this.appServer.threadBackgroundTerminalsTerminate({
                threadId: task.threadId,
                processId,
            });
            if (!this.queryIsCurrent(generation) || task.processId !== processId) return response.terminated;
            if (!response.terminated) {
                if (task.state === "stopping") task.state = "running";
                if (task.standardPublished) await this.reconcile(task.threadId, task.sessionId, false);
                return false;
            }
            await this.finish(task, "stopped");
            return true;
        } finally {
            if (task.state === "stopping") task.state = "running";
        }
    }

    clear(): void {
        this.disposed = true;
        this.prepareForAppServerReplacement();
        this.tasks.clear();
        this.ended.clear();
        this.syncs.clear();
    }

    private hasRunningTask(threadId: string): boolean {
        for (const task of this.tasks.values()) {
            if (task.threadId === threadId && task.state === "running") return true;
        }
        return false;
    }

    /** Forgets a task that ended and whose end the client has, or never needs. */
    private forget(task: Task): void {
        if (this.tasks.get(task.asyncTaskId) !== task) return;
        this.tasks.delete(task.asyncTaskId);
        this.ended.set(task.asyncTaskId, task.threadId);
    }

    private async syncThread(threadId: string, sessionId: string, discover: boolean): Promise<void> {
        const snapshot = await this.listAll(threadId);
        if (snapshot === null || !this.queryIsCurrent(snapshot.generation)) return;

        // A new foreground turn may start while the RPC is in flight. Its processes are
        // visible to the list before their start events are delivered on our notification lane.
        const discoverDetached = discover && this.appServer.runningTurnId?.(threadId) === undefined;
        const liveTaskIds = new Set<string>();
        const listedTaskIds = new Set(snapshot.terminals.map(terminal => wireTaskId(this.rootSessionId, threadId, terminal.itemId)));
        for (const [taskId, taskThreadId] of [...this.ended]) {
            if (taskThreadId === threadId && !listedTaskIds.has(taskId)) this.ended.delete(taskId);
        }
        for (const terminal of snapshot.terminals) {
            if (!this.queryIsCurrent(snapshot.generation)) return;
            liveTaskIds.add(terminal.itemId);
            if (this.ended.has(wireTaskId(this.rootSessionId, threadId, terminal.itemId))) continue;
            const task = this.remember(threadId, sessionId, terminal);
            if (this.enabled && task.publication === "unpublished" && task.state === "running") await this.announce(task);
            if (this.reportsStandard(sessionId) && discoverDetached && task.state === "running" && !task.standardPublished) {
                await this.publishStandard(task, snapshot.generation);
            }
        }

        for (const task of [...this.tasks.values()]) {
            if (!this.queryIsCurrent(snapshot.generation)) return;
            if (task.threadId === threadId
                && (task.publication === "published" || task.standardPublished || this.standard && discoverDetached)
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
                await this.syncThread(threadId, pending.sessionId, pending.discover);
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

    private publishStandard(task: Task, generation: number, reannounce = false): Promise<void> {
        return this.serializeStandard(task, async () => {
            if (!this.queryIsCurrent(generation) || isTerminalState(task.state)
                || this.tasks.get(task.asyncTaskId) !== task || task.standardPublished && !reannounce) return;
            const view = this.session.forSession(task.sessionId);
            await view.updateTerminal({
                terminalId: task.itemId,
                command: stripShellPrefix(task.name),
                ...(task.cwd !== undefined && isAbsoluteProtocolPath(task.cwd) ? {cwd: task.cwd} : {}),
                capabilities: {cancel: {}},
            });
            if (!this.isActive()) return;
            task.standardPublished = true;
            if (!isTerminalState(task.state)) {
                await view.setBackgroundItem({type: "terminal", terminalId: task.itemId}, true);
                this.schedulePoll();
            }
        });
    }

    private serializeStandard(task: Task, send: () => Promise<void>): Promise<void> {
        const sent = task.standardSend.then(send);
        task.standardSend = sent.catch(() => {});
        return sent;
    }

    private schedulePoll(): void {
        if (this.poll !== undefined || !this.canQueryAppServer()) return;
        this.poll = setTimeout(() => {
            this.poll = undefined;
            const scopes = new Map([...this.tasks.values()].filter(task => task.standardPublished
                && !isTerminalState(task.state)).map(task => [task.threadId, task.sessionId]));
            if (scopes.size === 0) return;
            void Promise.all([...scopes].map(([threadId, sessionId]) => this.reconcile(threadId, sessionId, false)))
                .then(() => { if ([...this.tasks.values()].some(task => task.standardPublished)) this.schedulePoll(); });
        }, LIVE_POLL_MS);
        this.poll.unref();
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
            if (terminal.cwd !== undefined) existing.cwd = terminal.cwd;
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
            ...(terminal.cwd !== undefined ? {cwd: terminal.cwd} : {}),
            standardPublished: false,
            reportedExit: false,
            standardSend: Promise.resolve(),
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
        if (this.standard) await this.serializeStandard(task, async () => {
            if (!task.standardPublished || !this.isActive()) return;
            const view = this.session.forSession(task.sessionId);
            await view.updateTerminal({
                terminalId: task.itemId,
                ...(task.reportedExit ? {} : {exitStatus: {exitCode: null, signal: null}}),
                capabilities: null,
            });
            task.standardPublished = false;
            await view.setBackgroundItem({type: "terminal", terminalId: task.itemId}, false);
        });
        if (task.publication === "published") await this.publishTerminalState(task);
        else this.forget(task);
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
            this.forget(task);
        } finally {
            if (task.terminalUpdate === terminalUpdate) task.terminalUpdate = null;
        }
    }

    private async listAll(threadId: string): Promise<TerminalSnapshot | null> {
        const appServer = this.appServer;
        const generation = this.appServerGeneration;
        const terminals: ThreadBackgroundTerminal[] = [];
        for await (const page of appServer.backgroundTerminalPages(threadId)) {
            if (!this.queryIsCurrent(generation)) return null;
            terminals.push(...page);
        }
        return {generation, terminals};
    }

    private isActive(): boolean {
        return (this.enabled || this.standard) && !this.disposed;
    }

    private reportsStandard(sessionId: string): boolean {
        return this.standard && (sessionId === this.rootSessionId || this.standardChildren);
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
