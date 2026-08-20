import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {UpdateSessionEvent} from "../ACPSessionConnection";
import {
    createCollabAgentToolCallCompleteUpdate,
    createCollabAgentToolCallUpdate,
    createSubAgentActivityUpdate,
} from "../CodexToolCallMapper";
import type {SubagentState} from "./AcpSubagents";

type Publisher = (update: UpdateSessionEvent, sessionId?: string) => Promise<void>;
type Log = (message: string) => void;

type NativeSubagent = {
    parentSessionId: string;
    name: string;
    task: string;
    terminalState?: SubagentState;
};

/** Owns native lifecycle, child routing, waiting, and legacy activity deduplication. */
export class CodexSubagentEventRouter {
    private readonly children = new Map<string, NativeSubagent>();
    private readonly waiters = new Set<() => void>();
    private readonly activeLegacyActivities = new Set<string>();

    constructor(
        private readonly rootSessionId: string,
        private readonly supported: boolean,
        private readonly publish: Publisher,
        private readonly log: Log,
    ) {}

    async handle(notification: ServerNotification): Promise<boolean> {
        if (notification.method !== "item/started" && notification.method !== "item/completed") {
            return false;
        }
        const item = notification.params.item;
        if (!this.supported) {
            // Permissions use their own ACP request path. Every transcript or
            // lifecycle representation stays hidden without bilateral support.
            return item.type === "collabAgentToolCall" || item.type === "subAgentActivity";
        }
        if (item.type === "subAgentActivity") {
            const hasNativeRepresentation = this.children.has(item.agentThreadId);
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
                    this.log("Ignoring spawned subagent with an empty thread id");
                    continue;
                }
                if (childSessionId === parentSessionId || childSessionId === this.rootSessionId) {
                    this.log(`Ignoring self-referential spawned subagent ${childSessionId}`);
                    continue;
                }
                if (this.children.has(childSessionId)) {
                    representedSpawn = true;
                    continue;
                }
                const child = {
                    parentSessionId,
                    name: fallbackName(childSessionId),
                    task: item.prompt?.trim() || "Delegated task",
                };
                this.children.set(childSessionId, child);
                representedSpawn = true;
                await this.publish({
                    sessionUpdate: "subagent_spawned",
                    subagentSessionId: childSessionId,
                    name: child.name,
                    task: child.task,
                    capabilities: {},
                }, parentSessionId);
            }
        }

        for (const [childSessionId, state] of Object.entries(item.agentsStates)) {
            const terminalState = state && terminalStateOf(state.status);
            if (terminalState) await this.finish(childSessionId, terminalState);
        }
        // `updated` is intentionally not synthesized: the portable protocol
        // currently defines only spawn and terminal lifecycle.
        return item.tool === "spawnAgent" && representedSpawn;
    }

    shouldIgnore(notification: ServerNotification): boolean {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        const ignored = typeof threadId === "string"
            && this.children.get(threadId)?.terminalState !== undefined;
        if (ignored) this.log(`Ignoring update for terminal subagent ${threadId}`);
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

    async wait(signal: AbortSignal): Promise<void> {
        while ([...this.children.values()].some(child => child.terminalState === undefined)) {
            if (signal.aborted) return;
            await new Promise<void>((resolve) => {
                const onAbort = () => {
                    this.waiters.delete(onChange);
                    resolve();
                };
                const onChange = () => {
                    signal.removeEventListener("abort", onAbort);
                    resolve();
                };
                this.waiters.add(onChange);
                signal.addEventListener("abort", onAbort, {once: true});
            });
        }
    }

    async finishOutstanding(state: SubagentState): Promise<void> {
        for (const childSessionId of [...this.children.keys()].reverse()) {
            await this.finish(childSessionId, state);
        }
    }

    private async finish(childSessionId: string, state: SubagentState): Promise<void> {
        const child = this.children.get(childSessionId);
        if (!child || child.terminalState !== undefined) return;
        child.terminalState = state;
        await this.publish({
            sessionUpdate: "subagent_state_update",
            subagentSessionId: childSessionId,
            state,
        }, child.parentSessionId);
        for (const waiter of this.waiters) waiter();
        this.waiters.clear();
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

function fallbackName(sessionId: string): string {
    const suffix = sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
    return `Agent ${suffix}`;
}
