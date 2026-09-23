import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import {logger} from "../Logger";
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
    generation: number;
    terminalState?: SubagentState;
};

type PendingSubagent = {
    parentThreadId: string;
    parentSessionId: string;
    task: string;
    buffered: PendingNotificationBuffer;
};

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
    private readonly terminalPendingSpawns = new Map<string, PendingSubagent>();
    private readonly waiters = new Set<() => void>();
    private readonly materializationWaiters = new Map<string, Set<(sessionId: string | null) => void>>();
    private readonly replayQueue: ServerNotification[] = [];
    private readonly activeLegacyActivities = new Set<string>();

    /**
     * @param onChildSessionEnded runs when a native child session ends, so that the owner can release
     *   the state that it keeps per child session.
     */
    constructor(
        private readonly rootSessionId: string,
        private readonly supported: boolean,
        private readonly session: ACPSessionConnection,
        private readonly onChildSessionEnded: (sessionId: string) => void = () => {},
    ) {}

    async handle(notification: ServerNotification): Promise<boolean> {
        if (notification.method === "turn/started") {
            return this.isKnownChild(notification.params.threadId);
        }
        if (notification.method === "turn/completed") {
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
            if (this.terminalPendingSpawns.has(item.agentThreadId)) return true;
            let hasNativeRepresentation = this.children.has(item.agentThreadId);
            if (!hasNativeRepresentation) {
                await this.materialize(item.agentThreadId, item.agentPath);
                hasNativeRepresentation = this.children.has(item.agentThreadId);
            }
            if (hasNativeRepresentation && item.kind === "interrupted") {
                await this.finish(item.agentThreadId, "cancelled");
            }
            return hasNativeRepresentation;
        }
        if (item.type !== "collabAgentToolCall") return false;

        if (item.tool === "resumeAgent" || item.tool === "sendInput") {
            for (const [childThreadId, state] of Object.entries(item.agentsStates)) {
                if (state?.status === "running" || state?.status === "pendingInit") {
                    await this.reopen(childThreadId);
                }
            }
        }

        let representedSpawn = false;
        if (item.tool === "spawnAgent") {
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
                this.pendingSpawns.set(childSessionId, {
                    parentThreadId,
                    parentSessionId,
                    task: item.prompt?.trim() || "Delegated task",
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

    private async materialize(childSessionId: string, path: string): Promise<void> {
        if (this.children.has(childSessionId)) return;
        const pending = this.pendingSpawns.get(childSessionId);
        const name = nameFromAgentPath(path, fallbackName(childSessionId));
        const inferredParent = this.parentForPath(path);
        const parentThreadId = pending?.parentThreadId ?? inferredParent.threadId;
        const parentSessionId = pending?.parentSessionId ?? inferredParent.sessionId;
        const task = pending?.task ?? `Delegated task for ${name}`;
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
            generation: 1,
        });
        this.pendingSpawns.delete(childSessionId);
        this.replayQueue.push(...(pending?.buffered.take() ?? []));
        this.resolveMaterialization(childSessionId, childSessionId);
    }

    private finishPending(childSessionId: string): void {
        const pending = this.pendingSpawns.get(childSessionId);
        if (!pending) return;
        this.pendingSpawns.delete(childSessionId);
        this.terminalPendingSpawns.set(childSessionId, pending);
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
    }

    private resolveMaterialization(childThreadId: string, sessionId: string | null): void {
        for (const resolve of this.materializationWaiters.get(childThreadId) ?? []) resolve(sessionId);
        this.materializationWaiters.delete(childThreadId);
    }

    private hasOutstanding(): boolean {
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
