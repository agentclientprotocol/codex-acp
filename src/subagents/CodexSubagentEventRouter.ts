import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import {ACPSessionConnection, type UpdateSessionEvent} from "../ACPSessionConnection";
import {logger} from "../Logger";
import {
    createCollabAgentToolCallCompleteUpdate,
    createCollabAgentToolCallUpdate,
    createSubAgentActivityUpdate,
} from "../CodexToolCallMapper";
import type {SubagentState} from "./AcpSubagents";
import {isRootAgentPath, nameFromAgentPath, normalizeAgentPath} from "./CodexAgentPath";

type NativeSubagent = {
    parentSessionId: string;
    name: string;
    description: string;
    path?: string;
    terminalState?: SubagentState;
};

type PendingSubagent = {
    parentSessionId: string;
    description: string;
};

/** Owns native lifecycle, child routing, waiting, and legacy activity deduplication. */
export class CodexSubagentEventRouter {
    private static readonly DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

    private readonly children = new Map<string, NativeSubagent>();
    private readonly pendingSpawns = new Map<string, PendingSubagent>();
    private readonly terminalPendingSpawns = new Set<string>();
    private readonly waiters = new Set<() => void>();
    private readonly activeLegacyActivities = new Set<string>();

    constructor(
        private readonly rootSessionId: string,
        private readonly supported: boolean,
        private readonly session: ACPSessionConnection,
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

        let representedSpawn = false;
        if (item.tool === "spawnAgent") {
            const parentSessionId = this.children.has(item.senderThreadId)
                ? item.senderThreadId
                : this.rootSessionId;
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
                    parentSessionId,
                    description: item.prompt?.trim() || "Delegated task",
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
            ? threadId
            : this.rootSessionId;
    }

    legacyActivityStarted(item: ThreadItem & {type: "subAgentActivity"}): UpdateSessionEvent {
        this.activeLegacyActivities.add(item.id);
        return createSubAgentActivityUpdate(item, "in_progress", "tool_call");
    }

    legacyCollaborationStarted(item: ThreadItem & {type: "collabAgentToolCall"}): UpdateSessionEvent {
        return createCollabAgentToolCallUpdate(item);
    }

    legacyCollaborationCompleted(item: ThreadItem & {type: "collabAgentToolCall"}): UpdateSessionEvent {
        return createCollabAgentToolCallCompleteUpdate(item);
    }

    legacyActivityCompleted(item: ThreadItem & {type: "subAgentActivity"}): UpdateSessionEvent {
        const sessionUpdate = this.activeLegacyActivities.delete(item.id)
            ? "tool_call_update"
            : "tool_call";
        return createSubAgentActivityUpdate(item, "completed", sessionUpdate);
    }

    async wait(
        signal: AbortSignal,
        timeoutMs = CodexSubagentEventRouter.DEFAULT_WAIT_TIMEOUT_MS,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.hasOutstanding()) {
            if (signal.aborted) return;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                logger.log(`Timed out waiting for subagents in session ${this.rootSessionId}; marking them failed`);
                await this.finishOutstanding("failed");
                return;
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
                await this.finishOutstanding("failed");
                return;
            }
        }
    }

    async finishOutstanding(state: SubagentState): Promise<void> {
        for (const childSessionId of [...this.pendingSpawns.keys()]) {
            this.finishPending(childSessionId);
        }
        for (const childSessionId of [...this.children.keys()].reverse()) {
            await this.finish(childSessionId, state);
        }
    }

    private hasOutstanding(): boolean {
        return this.pendingSpawns.size > 0
            || [...this.children.values()].some(child => child.terminalState === undefined);
    }

    private isKnownChild(threadId: string): boolean {
        return threadId !== this.rootSessionId
            && (this.children.has(threadId)
                || this.pendingSpawns.has(threadId)
                || this.terminalPendingSpawns.has(threadId));
    }

    private async materialize(childSessionId: string, path: string): Promise<void> {
        if (this.children.has(childSessionId)) return;
        const pending = this.pendingSpawns.get(childSessionId);
        const name = nameFromAgentPath(path, fallbackName(childSessionId));
        const parentSessionId = pending?.parentSessionId
            ?? this.parentSessionIdForPath(path);
        const description = pending?.description ?? `Delegated task for ${name}`;
        await this.session.update({
            sessionUpdate: "subagent_spawned",
            subagentSessionId: childSessionId,
            name,
            description,
            capabilities: {},
        }, parentSessionId);
        this.children.set(childSessionId, {
            parentSessionId,
            name,
            description,
            path: normalizeAgentPath(path),
        });
        this.pendingSpawns.delete(childSessionId);
    }

    private finishPending(childSessionId: string): void {
        if (!this.pendingSpawns.delete(childSessionId)) return;
        this.terminalPendingSpawns.add(childSessionId);
        for (const waiter of this.waiters) waiter();
        this.waiters.clear();
    }

    private async finish(childSessionId: string, state: SubagentState): Promise<void> {
        const child = this.children.get(childSessionId);
        if (!child || child.terminalState !== undefined) return;
        await this.session.update({
            sessionUpdate: "subagent_state_update",
            subagentSessionId: childSessionId,
            state,
        }, child.parentSessionId);
        child.terminalState = state;
        for (const waiter of this.waiters) waiter();
        this.waiters.clear();
    }

    private parentSessionIdForPath(path: string): string {
        const normalized = normalizeAgentPath(path);
        const separator = normalized.lastIndexOf("/");
        if (separator <= 0) return this.rootSessionId;
        const parentPath = normalized.slice(0, separator);
        return [...this.children.entries()]
            .find(([, child]) => child.path === parentPath)?.[0]
            ?? this.rootSessionId;
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
