import type {ServerNotification} from "../app-server";
import type {Model, ThreadItem} from "../app-server/v2";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import {logger} from "../Logger";
import {createSubagentModelConfigOption} from "../ModelConfigOption";
import {CollabAgentReporter} from "../tool-calls/reporters/CollabAgentReporter";
import {SubagentActivityReporter} from "../tool-calls/reporters/SubagentActivityReporter";
import type {ToolFacts} from "../tool-calls/ToolFacts";
import type {SubagentState} from "./AcpSubagents";
import {PendingNotificationBuffer} from "./PendingNotificationBuffer";
import {isRootAgentPath, nameFromAgentPath, normalizeAgentPath} from "./CodexAgentPath";

type NativeSubagent = {
    parentThreadId: string;
    parentSessionId: string;
    sessionId: string;
    name: string;
    task: string;
    path?: string;
    /** The model of the child, or `undefined` when the adapter does not know it. */
    model?: ChildModel;
    generation: number;
    terminalState?: SubagentState;
};

type PendingSubagent = {
    parentThreadId: string;
    parentSessionId: string;
    task: string;
    model?: ChildModel;
    buffered: PendingNotificationBuffer;
};

/** A spawn that ended before it materialized. It keeps only what a reopen needs, not the buffered updates. */
type EndedSpawn = {
    parentThreadId: string;
    task: string;
    model?: ChildModel;
};

/**
 * Where Codex stated the model of a child. The adapter reports only these models and never guesses one from the
 * spawn request or the parent. A source of a higher rank wins: at the creation the activity item names the resolved
 * model, and a settings change is a real change of the model.
 */
export const MODEL_SOURCE_RANK = {threadStarted: 0, activity: 1, settings: 2} as const;

export type ChildModel = {
    model: string;
    source: keyof typeof MODEL_SOURCE_RANK;
};

/** A report of a lower rank does not replace the model, so a `thread/started` of a resume keeps the activity model. */
export function preferredModel(current: ChildModel | undefined, next: ChildModel): ChildModel;
export function preferredModel(current: ChildModel | undefined, next: ChildModel | undefined): ChildModel | undefined;
export function preferredModel(current: ChildModel | undefined, next: ChildModel | undefined): ChildModel | undefined {
    if (!current || !next) return current ?? next;
    return MODEL_SOURCE_RANK[next.source] >= MODEL_SOURCE_RANK[current.source] ? next : current;
}

/** The models of the root session, which give the value and the name of a child model. */
export type SubagentModels = {
    /** The base model id of the root session, or `null` when it is not known. */
    currentModel: string | null;
    availableModels: ReadonlyArray<Model>;
};

/**
 * Sends the model option of a child session. The client may not change it, so the option offers only the current
 * model. A child whose model is not known gets no configuration. The report is optional, so its failure is logged
 * and does not stop the child lifecycle or a replay.
 */
export async function reportSubagentModel(
    session: ACPSessionConnection,
    childSessionId: string,
    models: SubagentModels | null,
    model: string | undefined,
): Promise<void> {
    if (!model || !models) return;
    try {
        await session.update({
            sessionUpdate: "config_option_update",
            configOptions: [createSubagentModelConfigOption(models.availableModels, models.currentModel, model)],
        }, childSessionId);
    }
    catch (error) {
        logger.error(`Failed to report the model of subagent session ${childSessionId}`, error);
    }
}

export type ClosingChildSession = {
    threadId: string;
    sessionId: string;
    state: SubagentState;
};

/** Owns native lifecycle, child routing, waiting, and legacy activity deduplication. */
export class CodexSubagentEventRouter {
    private static readonly DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

    private readonly children = new Map<string, NativeSubagent>();
    private readonly pendingSpawns = new Map<string, PendingSubagent>();
    private readonly terminalPendingSpawns = new Map<string, EndedSpawn>();
    private readonly waiters = new Set<() => void>();
    private readonly materializationWaiters = new Map<string, Set<(sessionId: string | null) => void>>();
    private readonly replayQueue: ServerNotification[] = [];
    private readonly activeLegacyActivities = new Set<string>();
    /**
     * Models that Codex reported for threads of this root before their spawn named them. The root turn end and the
     * end of the outstanding children clear them. The router goes away with its session.
     */
    private readonly earlyThreadModels = new Map<string, ChildModel>();
    /** The `spawnAgent` items of this root that started and did not complete yet. */
    private readonly spawnsInFlight = new Set<string>();
    /**
     * The params of settings changes that the router read while it buffered them for a pending child. The buffer
     * stores a copy of the notification with the same params.
     */
    private readonly appliedSettings = new WeakSet<object>();

    /**
     * @param onChildSessionEnded runs when a native child session ends, so that the owner can release
     *   the state that it keeps per child session.
     * @param rootModels gives the models of the root session when a child needs them, or `null` when the client
     *   gets no session configuration.
     */
    constructor(
        private readonly rootSessionId: string,
        private readonly supported: boolean,
        private readonly session: ACPSessionConnection,
        private readonly onChildSessionEnded: (sessionId: string) => void,
        private readonly rootModels: () => SubagentModels | null,
    ) {}

    async handle(notification: ServerNotification): Promise<boolean> {
        if (notification.method === "thread/started") {
            const thread = notification.params.thread;
            // Every session gets the thread starts of the app-server, so a thread that is not known yet must name
            // this root as its parent, or start while a spawn of this root is in flight.
            const ofThisRoot = thread.parentThreadId === this.rootSessionId
                || (thread.parentThreadId !== null && this.children.has(thread.parentThreadId))
                || this.spawnsInFlight.size > 0;
            if (thread.model) {
                await this.applyThreadModel(thread.id, {model: thread.model, source: "threadStarted"}, ofThisRoot);
            }
            return false;
        }
        // Read a settings change before the buffering below, so that a pending child announces with its model.
        // The buffered copy comes back after the announcement, and the router does not read it again.
        if (notification.method === "thread/settings/updated" && !this.appliedSettings.delete(notification.params)) {
            const threadId = notification.params.threadId;
            await this.applyThreadModel(threadId, {
                model: notification.params.threadSettings.model,
                source: "settings",
            }, this.spawnsInFlight.size > 0);
            if (this.pendingSpawns.has(threadId)) this.appliedSettings.add(notification.params);
        }
        if (notification.method === "turn/started") {
            const childTurn = this.isKnownChild(notification.params.threadId);
            // A follow-up can start a new turn of an ended child with no collaboration item that reports it.
            if (childTurn) await this.reopen(notification.params.threadId);
            return childTurn;
        }
        if (notification.method === "turn/completed") {
            if (notification.params.threadId === this.rootSessionId) {
                this.earlyThreadModels.clear();
                this.spawnsInFlight.clear();
            }
            const childTurn = this.isKnownChild(notification.params.threadId);
            const state = terminalStateFromTurn(notification.params.turn.status);
            if (!state) return childTurn;
            if (notification.params.threadId === this.rootSessionId) {
                if (state !== "completed") await this.finishOutstanding(state);
            }
            else {
                if (this.pendingSpawns.has(notification.params.threadId)) {
                    this.finishPending(notification.params.threadId);
                }
                else {
                    await this.finish(notification.params.threadId, state);
                }
            }
            return childTurn;
        }
        const notificationThreadId = (notification.params as {threadId?: unknown}).threadId;
        if (typeof notificationThreadId === "string" && this.pendingSpawns.has(notificationThreadId)) {
            this.pendingSpawns.get(notificationThreadId)!.buffered.push(notification);
            return true;
        }
        if (notification.method !== "item/started" && notification.method !== "item/completed") {
            return false;
        }
        const item = notification.params.item;
        if (!this.supported) {
            // Preserve the pre-native protocol representation for clients that
            // did not negotiate child sessions. The normal event mapper renders
            // collaboration lifecycle as ordinary ACP tool calls.
            return false;
        }
        if (item.type === "subAgentActivity") {
            // Codex reports the root participant through the same activity item
            // shape as children. It is the parent conversation, not a subagent.
            if (isRootAgentPath(item.agentPath)) return true;
            if (this.terminalPendingSpawns.has(item.agentThreadId)) {
                if (item.model) await this.applyThreadModel(item.agentThreadId, {model: item.model, source: "activity"}, false);
                return true;
            }
            let hasNativeRepresentation = this.children.has(item.agentThreadId);
            if (!hasNativeRepresentation) {
                await this.materialize(item.agentThreadId, item.agentPath, item.model);
                hasNativeRepresentation = this.children.has(item.agentThreadId);
            }
            if (hasNativeRepresentation && item.kind === "interrupted") {
                await this.finish(item.agentThreadId, "cancelled");
            }
            return hasNativeRepresentation;
        }
        if (item.type !== "collabAgentToolCall") return false;

        // These tools start a turn of an idle child. A `sendMessage` only queues the message and starts no turn.
        if (item.tool === "resumeAgent" || item.tool === "sendInput" || item.tool === "followupTask") {
            for (const [childThreadId, state] of Object.entries(item.agentsStates)) {
                if (state?.status === "running" || state?.status === "pendingInit") {
                    await this.reopen(childThreadId);
                }
            }
        }

        let representedSpawn = false;
        if (item.tool === "spawnAgent") {
            if (notification.method === "item/started") this.spawnsInFlight.add(item.id);
            else this.spawnsInFlight.delete(item.id);
            const parent = this.children.get(item.senderThreadId);
            const parentThreadId = parent ? item.senderThreadId : this.rootSessionId;
            const parentSessionId = parent?.sessionId ?? this.rootSessionId;
            for (const childSessionId of item.receiverThreadIds) {
                if (childSessionId.trim().length === 0) {
                    logger.log("Ignoring spawned subagent with an empty thread id");
                    continue;
                }
                if (childSessionId === parentSessionId || childSessionId === this.rootSessionId) {
                    logger.log(`Ignoring self-referential spawned subagent ${childSessionId}`);
                    continue;
                }
                if (this.children.has(childSessionId)
                    || this.pendingSpawns.has(childSessionId)
                    || this.terminalPendingSpawns.has(childSessionId)) {
                    representedSpawn = true;
                    continue;
                }
                const model = this.takeEarlyModel(childSessionId);
                this.pendingSpawns.set(childSessionId, {
                    parentThreadId,
                    parentSessionId,
                    task: item.prompt?.trim() || "Delegated task",
                    ...(model ? {model} : {}),
                    buffered: new PendingNotificationBuffer(childSessionId),
                });
                representedSpawn = true;
            }
        }

        for (const [childSessionId, state] of Object.entries(item.agentsStates)) {
            const terminalState = state && terminalStateOf(state.status);
            if (!terminalState) continue;
            if (this.children.has(childSessionId)) await this.finish(childSessionId, terminalState);
            else if (this.pendingSpawns.has(childSessionId)) this.finishPending(childSessionId);
        }
        if (item.tool === "spawnAgent" && item.status === "failed") {
            for (const childSessionId of item.receiverThreadIds) {
                if (this.pendingSpawns.has(childSessionId)) this.finishPending(childSessionId);
            }
        }
        // `updated` is intentionally not synthesized: the portable protocol
        // currently defines only spawn and terminal lifecycle.
        return item.tool === "spawnAgent" && representedSpawn;
    }

    shouldIgnore(notification: ServerNotification): boolean {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        const ignored = typeof threadId === "string"
            && (this.children.get(threadId)?.terminalState !== undefined
                || this.terminalPendingSpawns.has(threadId));
        if (ignored) logger.log(`Ignoring update for terminal subagent ${threadId}`);
        return ignored;
    }

    /** Whether the thread is a native subagent that has its own ACP session. */
    isNativeSubagentThread(threadId: string): boolean {
        return threadId !== this.rootSessionId && this.children.has(threadId);
    }

    notificationSessionId(notification: ServerNotification): string {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        return typeof threadId === "string" && this.children.has(threadId)
            ? this.children.get(threadId)!.sessionId
            : this.rootSessionId;
    }

    closingChildSessions(notification: ServerNotification): ClosingChildSession[] {
        if (!this.supported) return [];
        if (notification.method === "turn/completed") {
            const state = terminalStateFromTurn(notification.params.turn.status);
            if (state === undefined) return [];
            if (notification.params.threadId === this.rootSessionId && state !== "completed") {
                return [...this.children.keys()].flatMap(threadId => this.closingChildSession(threadId, state));
            }
            return this.closingChildSession(notification.params.threadId, state);
        }
        if (notification.method !== "item/started" && notification.method !== "item/completed") return [];
        const item = notification.params.item;
        if (item.type === "subAgentActivity") {
            return item.kind === "interrupted" ? this.closingChildSession(item.agentThreadId, "cancelled") : [];
        }
        if (item.type !== "collabAgentToolCall") return [];

        const closing = new Map<string, ClosingChildSession>();
        for (const [threadId, state] of Object.entries(item.agentsStates)) {
            const terminalState = state && terminalStateOf(state.status);
            if (!terminalState) continue;
            for (const child of this.closingChildSession(threadId, terminalState)) closing.set(threadId, child);
        }
        return [...closing.values()];
    }

    /** The ACP session ids of the native subagent sessions that have not ended. */
    childSessionIds(): string[] {
        return [...this.children.values()]
            .filter(child => child.terminalState === undefined)
            .map(child => child.sessionId);
    }

    takeBufferedNotifications(): ServerNotification[] {
        return this.replayQueue.splice(0);
    }

    async waitForMaterializedSession(childThreadId: string): Promise<string | null> {
        const child = this.children.get(childThreadId);
        if (child) return child.terminalState === undefined ? child.sessionId : null;
        if (this.terminalPendingSpawns.has(childThreadId)) return null;
        if (!this.pendingSpawns.has(childThreadId)) return null;
        return await new Promise(resolve => {
            const waiters = this.materializationWaiters.get(childThreadId) ?? new Set();
            waiters.add(resolve);
            this.materializationWaiters.set(childThreadId, waiters);
        });
    }

    legacyActivityStarted(item: ThreadItem & {type: "subAgentActivity"}): ToolFacts {
        this.activeLegacyActivities.add(item.id);
        return SubagentActivityReporter.activity(item, "in_progress", "start");
    }

    legacyCollaborationStarted(item: ThreadItem & {type: "collabAgentToolCall"}): ToolFacts {
        return CollabAgentReporter.started(item);
    }

    legacyCollaborationCompleted(item: ThreadItem & {type: "collabAgentToolCall"}): ToolFacts {
        return CollabAgentReporter.completed(item);
    }

    legacyActivityCompleted(item: ThreadItem & {type: "subAgentActivity"}): ToolFacts {
        const report = this.activeLegacyActivities.delete(item.id) ? "update" : "start";
        return SubagentActivityReporter.activity(item, "completed", report);
    }

    /** The caller finalizes pending child updates before closing timed-out sessions. */
    async wait(
        signal: AbortSignal,
        timeoutMs = CodexSubagentEventRouter.DEFAULT_WAIT_TIMEOUT_MS,
    ): Promise<"settled" | "aborted" | "timed_out"> {
        const deadline = Date.now() + timeoutMs;
        while (this.hasOutstanding()) {
            if (signal.aborted) return "aborted";
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                logger.log(`Timed out waiting for subagents in session ${this.rootSessionId}; marking them failed`);
                return "timed_out";
            }
            const changed = await new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => {
                    this.waiters.delete(onChange);
                    signal.removeEventListener("abort", onAbort);
                    resolve(false);
                }, remainingMs);
                const onAbort = () => {
                    clearTimeout(timeout);
                    this.waiters.delete(onChange);
                    resolve(true);
                };
                const onChange = () => {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", onAbort);
                    resolve(true);
                };
                this.waiters.add(onChange);
                signal.addEventListener("abort", onAbort, {once: true});
            });
            if (!changed) {
                logger.log(`Timed out waiting for subagents in session ${this.rootSessionId}; marking them failed`);
                return "timed_out";
            }
        }
        return "settled";
    }

    async finishOutstanding(state: SubagentState): Promise<void> {
        this.earlyThreadModels.clear();
        this.spawnsInFlight.clear();
        for (const childSessionId of [...this.pendingSpawns.keys()]) {
            this.finishPending(childSessionId);
        }
        for (const childSessionId of [...this.children.keys()].reverse()) {
            await this.finish(childSessionId, state);
        }
    }

    private isKnownChild(threadId: string): boolean {
        return threadId !== this.rootSessionId
            && (this.children.has(threadId)
                || this.pendingSpawns.has(threadId)
                || this.terminalPendingSpawns.has(threadId));
    }

    private closingChildSession(threadId: string, state: SubagentState): ClosingChildSession[] {
        const child = this.children.get(threadId);
        return child && child.terminalState === undefined
            ? [{threadId, sessionId: child.sessionId, state}]
            : [];
    }

    private async materialize(childSessionId: string, path: string, resolvedModel: string | null): Promise<void> {
        if (this.children.has(childSessionId)) return;
        const pending = this.pendingSpawns.get(childSessionId);
        const name = nameFromAgentPath(path, fallbackName(childSessionId));
        const inferredParent = this.parentForPath(path);
        const parentThreadId = pending?.parentThreadId ?? inferredParent.threadId;
        const parentSessionId = pending?.parentSessionId ?? inferredParent.sessionId;
        const task = pending?.task ?? `Delegated task for ${name}`;
        const model = preferredModel(
            pending ? pending.model : this.takeEarlyModel(childSessionId),
            resolvedModel ? {model: resolvedModel, source: "activity"} : undefined,
        );
        await this.session.update({
            sessionUpdate: "subagent_spawned",
            subagentSessionId: childSessionId,
            name,
            task,
            capabilities: {},
        }, parentSessionId);
        this.children.set(childSessionId, {
            parentThreadId,
            parentSessionId,
            sessionId: childSessionId,
            name,
            task,
            path: normalizeAgentPath(path),
            ...(model ? {model} : {}),
            generation: 1,
        });
        this.pendingSpawns.delete(childSessionId);
        // A loop, not push(...): a spread of a large buffer exceeds the argument limit and throws.
        for (const notification of pending?.buffered.take() ?? []) this.replayQueue.push(notification);
        this.resolveMaterialization(childSessionId, childSessionId);
        await this.reportModel(childSessionId, childSessionId);
    }

    private finishPending(childSessionId: string): void {
        const pending = this.pendingSpawns.get(childSessionId);
        if (!pending) return;
        this.pendingSpawns.delete(childSessionId);
        // The child ended before Codex reported its activity, so it is not shown. The record keeps no buffer,
        // so its buffered updates are dropped.
        this.terminalPendingSpawns.set(childSessionId, {
            parentThreadId: pending.parentThreadId,
            task: pending.task,
            ...(pending.model ? {model: pending.model} : {}),
        });
        this.onChildSessionEnded(childSessionId);
        this.resolveMaterialization(childSessionId, null);
        this.notifyWaiters();
    }

    private async finish(childSessionId: string, state: SubagentState): Promise<void> {
        const child = this.children.get(childSessionId);
        if (!child || child.terminalState !== undefined) return;
        child.terminalState = state;
        try {
            await this.session.update({
                sessionUpdate: "subagent_state_update",
                subagentSessionId: child.sessionId,
                state,
            }, child.parentSessionId);
        }
        catch (error) {
            if (child.terminalState === state) delete child.terminalState;
            throw error;
        }
        this.onChildSessionEnded(child.sessionId);
        this.notifyWaiters();
    }

    private async reopen(childThreadId: string): Promise<void> {
        const child = this.children.get(childThreadId);
        if (!child) {
            const pending = this.terminalPendingSpawns.get(childThreadId);
            if (!pending) return;
            const parentSessionId = this.children.get(pending.parentThreadId)?.sessionId ?? this.rootSessionId;
            const reopened: NativeSubagent = {
                parentThreadId: pending.parentThreadId,
                parentSessionId,
                sessionId: `${childThreadId}:generation:2`,
                name: fallbackName(childThreadId),
                task: pending.task,
                ...(pending.model ? {model: pending.model} : {}),
                generation: 2,
            };
            await this.session.update({
                sessionUpdate: "subagent_spawned",
                subagentSessionId: reopened.sessionId,
                name: reopened.name,
                task: reopened.task,
                capabilities: {},
            }, parentSessionId);
            this.children.set(childThreadId, reopened);
            this.terminalPendingSpawns.delete(childThreadId);
            await this.reportModel(childThreadId, reopened.sessionId);
            return;
        }
        if (!child.terminalState) return;
        const previousSessionId = child.sessionId;
        const previousParentSessionId = child.parentSessionId;
        const previousState = child.terminalState;
        child.parentSessionId = this.children.get(child.parentThreadId)?.sessionId ?? this.rootSessionId;
        child.generation += 1;
        child.sessionId = `${childThreadId}:generation:${child.generation}`;
        delete child.terminalState;
        try {
            await this.session.update({
                sessionUpdate: "subagent_spawned",
                subagentSessionId: child.sessionId,
                name: child.name,
                task: child.task,
                capabilities: {},
            }, child.parentSessionId);
        }
        catch (error) {
            child.generation -= 1;
            child.sessionId = previousSessionId;
            child.parentSessionId = previousParentSessionId;
            child.terminalState = previousState;
            throw error;
        }
        await this.reportModel(childThreadId, child.sessionId);
    }

    /** Takes a model that Codex reports for a child thread, when its source does not rank below the known one. */
    private async applyThreadModel(threadId: string, model: ChildModel, mayBeEarly: boolean): Promise<void> {
        if (!this.supported || threadId === this.rootSessionId) return;
        const pending = this.pendingSpawns.get(threadId) ?? this.terminalPendingSpawns.get(threadId);
        if (pending) {
            pending.model = preferredModel(pending.model, model);
            return;
        }
        const child = this.children.get(threadId);
        if (!child) {
            // A spawn can name its child only when it completes, after the child thread started.
            if (mayBeEarly) {
                this.earlyThreadModels.set(threadId, preferredModel(this.earlyThreadModels.get(threadId), model));
            }
            return;
        }
        const previous = child.model;
        child.model = preferredModel(previous, model);
        if (child.model === previous || child.terminalState !== undefined) return;
        if (previous && this.modelValue(previous.model) === this.modelValue(model.model)) return;
        await this.reportModel(threadId, child.sessionId);
    }

    private takeEarlyModel(threadId: string): ChildModel | undefined {
        const model = this.earlyThreadModels.get(threadId);
        this.earlyThreadModels.delete(threadId);
        return model;
    }

    /** The value of the model option for a model, which can differ from the model string that Codex reports. */
    private modelValue(model: string): string {
        const models = this.rootModels();
        const option = createSubagentModelConfigOption(models?.availableModels ?? [], models?.currentModel ?? null, model);
        return String(option.currentValue);
    }

    /**
     * Sends the current model of a child session after its announcement. A child that ended, or that a reopen gave
     * another session, gets nothing: an end can come while the router waits for the client.
     */
    private async reportModel(childThreadId: string, childSessionId: string): Promise<void> {
        const child = this.children.get(childThreadId);
        if (!child || child.terminalState !== undefined || child.sessionId !== childSessionId) return;
        // A pending child can end while the router waits for the client to take its announcement.
        if (this.terminalPendingSpawns.has(childThreadId)) return;
        await reportSubagentModel(this.session, childSessionId, this.rootModels(), child.model?.model);
    }

    private resolveMaterialization(childThreadId: string, sessionId: string | null): void {
        for (const resolve of this.materializationWaiters.get(childThreadId) ?? []) resolve(sessionId);
        this.materializationWaiters.delete(childThreadId);
    }

    /** Some native subagent has not ended yet. */
    hasOutstanding(): boolean {
        return this.pendingSpawns.size > 0
            || [...this.children.values()].some(child => child.terminalState === undefined);
    }

    private notifyWaiters(): void {
        for (const waiter of this.waiters) waiter();
        this.waiters.clear();
    }

    private parentForPath(path: string): {threadId: string; sessionId: string} {
        const normalized = normalizeAgentPath(path);
        const separator = normalized.lastIndexOf("/");
        if (separator <= 0) return {threadId: this.rootSessionId, sessionId: this.rootSessionId};
        const parentPath = normalized.slice(0, separator);
        const parent = [...this.children.entries()].find(([, child]) => child.path === parentPath);
        return parent
            ? {threadId: parent[0], sessionId: parent[1].sessionId}
            : {threadId: this.rootSessionId, sessionId: this.rootSessionId};
    }
}

function terminalStateOf(
    status: "pendingInit" | "running" | "completed" | "errored" | "shutdown" | "notFound" | "interrupted",
): SubagentState | undefined {
    switch (status) {
        case "completed":
            return "completed";
        case "interrupted":
            return "cancelled";
        case "errored":
        case "shutdown":
        case "notFound":
            return "failed";
        case "pendingInit":
        case "running":
            return undefined;
    }
}

function terminalStateFromTurn(
    status: "inProgress" | "completed" | "interrupted" | "failed",
): SubagentState | undefined {
    switch (status) {
        case "completed":
            return "completed";
        case "interrupted":
            return "cancelled";
        case "failed":
            return "failed";
        case "inProgress":
            return undefined;
    }
}

function fallbackName(sessionId: string): string {
    const suffix = sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
    return `Agent ${suffix}`;
}
