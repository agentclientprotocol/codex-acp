import type {ServerNotification} from "./app-server";
import {isModelOutputItem} from "./CodexEventHandler";
import type {ModelTokenCount} from "./QuotaMeta";
import {isRootAgentPath} from "./subagents/CodexAgentPath";
import {type ChildModel, preferredModel} from "./subagents/CodexSubagentEventRouter";
import {
    addTokenCounts,
    sameTokenCount,
    subtractTokenCounts,
    toTokenCount,
    type TokenCount,
    ZERO_TOKEN_COUNT,
} from "./TokenCount";

type ChildThread = {
    model?: ChildModel;
    /** The last total of the thread, or null when the total it started from is not known. */
    previousTotal: TokenCount | null;
    modelOutputSeen: boolean;
    /** The sum of the model requests of the thread. */
    used: TokenCount;
    /** The part of `used` that a prompt reported. */
    reported: TokenCount;
    /** The part of `used` that the prompts before the current one reported. */
    reportedBeforePrompt: TokenCount;
};

/**
 * Accumulates the token usage of the child threads of a session: its subagents and their subagents. Codex reports
 * the usage of every thread on its own, and the usage of the root thread does not include its children, so a prompt
 * reports theirs in `_meta.quota.model_usage` next to its own.
 *
 * It reads the notifications as the app-server sends them, before the session routes them: a client without
 * subagent sessions gets the notifications of a child attributed to the root thread. A child that is still working
 * when a prompt ends adds its later usage to the next prompt that starts model work.
 *
 * Codex 0.165 sends no `thread/started` for a subagent: the tracker then learns the child from its `subAgentActivity`
 * item and its own notifications, with an unknown start, so the usage of a child counts from its first model output.
 */
export class SubagentTokenUsage {
    private readonly threads = new Map<string, ChildThread>();

    constructor(private readonly rootThreadId: string) {}

    observe(notification: ServerNotification): void {
        switch (notification.method) {
            case "thread/started": {
                const thread = notification.params.thread;
                const parent = thread.parentThreadId;
                // Every session gets every thread start, so only the children of this root count.
                if (thread.id === this.rootThreadId || parent === null
                    || (parent !== this.rootThreadId && !this.threads.has(parent))) return;
                // A new thread starts at zero, while a forked one starts from the usage of its history.
                const child = this.child(thread.id, thread.forkedFromId === null ? ZERO_TOKEN_COUNT : null);
                if (thread.model) child.model = preferredModel(child.model, {model: thread.model, source: "threadStarted"});
                return;
            }
            case "thread/settings/updated": {
                const threadId = notification.params.threadId;
                if (threadId === this.rootThreadId) return;
                const child = this.child(threadId, null);
                child.model = preferredModel(child.model, {model: notification.params.threadSettings.model, source: "settings"});
                return;
            }
            case "item/started":
            case "item/completed": {
                const {threadId, item} = notification.params;
                if (item.type === "subAgentActivity" && item.model && !isRootAgentPath(item.agentPath)) {
                    const child = this.child(item.agentThreadId, null);
                    child.model = preferredModel(child.model, {model: item.model, source: "activity"});
                }
                if (notification.method === "item/started" && threadId !== this.rootThreadId && isModelOutputItem(item)) {
                    this.child(threadId, null).modelOutputSeen = true;
                }
                return;
            }
            case "thread/tokenUsage/updated": {
                const threadId = notification.params.threadId;
                if (threadId === this.rootThreadId) return;
                const child = this.child(threadId, null);
                const total = toTokenCount(notification.params.tokenUsage.total);
                const previous = child.previousTotal;
                // Codex sends the current usage again when a model request starts; it is not a new request.
                if (previous !== null && sameTokenCount(total, previous)) return;
                child.previousTotal = total;
                // Before any output, an update of a thread with an unknown start carries its history, as in
                // PromptTokenUsage.
                if (previous === null && !child.modelOutputSeen) return;
                child.used = addTokenCounts(child.used, toTokenCount(notification.params.tokenUsage.last));
                return;
            }
        }
    }

    /** Starts a prompt that does model work: the child usage that no prompt reported yet belongs to it. */
    beginPrompt(): void {
        for (const thread of this.threads.values()) thread.reportedBeforePrompt = thread.reported;
    }

    /**
     * The `model_usage` rows of the current prompt: the usage of the root thread, then the usage of the children by
     * model, with the same model in one row. The child usage counts as reported. A child whose model Codex did not
     * report is counted for the root model, which a spawn that names no model inherits.
     */
    reportModelUsage(rootModel: string, rootUsage: TokenCount | null): ModelTokenCount[] {
        const byModel = new Map<string, TokenCount>();
        if (rootUsage !== null) byModel.set(rootModel, rootUsage);
        for (const thread of this.threads.values()) {
            const usage = subtractTokenCounts(thread.used, thread.reportedBeforePrompt);
            thread.reported = thread.used;
            if (sameTokenCount(usage, ZERO_TOKEN_COUNT)) continue;
            const model = thread.model?.model ?? rootModel;
            const current = byModel.get(model);
            byModel.set(model, current === undefined ? usage : addTokenCounts(current, usage));
        }
        return [...byModel].map(([model, token_count]) => ({model, token_count}));
    }

    private child(threadId: string, startTotal: TokenCount | null): ChildThread {
        let child = this.threads.get(threadId);
        if (child === undefined) {
            child = {
                previousTotal: startTotal,
                modelOutputSeen: false,
                used: ZERO_TOKEN_COUNT,
                reported: ZERO_TOKEN_COUNT,
                reportedBeforePrompt: ZERO_TOKEN_COUNT,
            };
            this.threads.set(threadId, child);
        }
        return child;
    }
}
