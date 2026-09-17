import type {ThreadTokenUsage} from "./app-server/v2";
import {toTokenCount, type TokenCount} from "./TokenCount";

const fields = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
export const ZERO_TOKEN_COUNT: TokenCount = {
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
};

/** Usage observed during one ACP prompt. Context occupancy is not usage. */
export class PromptTokenUsage {
    private counts: TokenCount | null = null;
    private incomplete = false;
    private started = false;

    constructor(private previous: TokenCount | null) {}

    restoreBaseline(total: TokenCount): void {
        // A resume snapshot can arrive after session/resume but before turn/start.
        if (!this.started) this.previous = total;
    }

    observe(usage: ThreadTokenUsage): void {
        this.started = true;
        const total = toTokenCount(usage.total);
        const previous = this.previous;
        this.previous = total;
        if (previous === null) {
            // A first notification can repeat historical usage on a rate-limit
            // update. Without a baseline, even `last` cannot safely be charged.
            this.incomplete = true;
            return;
        }
        const delta = {...total};
        for (const field of fields) delta[field] -= previous[field];
        if (fields.some(field => !Number.isSafeInteger(delta[field]) || delta[field] < 0)
            || delta.reasoningOutputTokens > delta.outputTokens
            || delta.totalTokens !== delta.inputTokens + delta.cachedInputTokens + delta.outputTokens) {
            // Codex can replace counters with a synthetic context-window estimate.
            this.incomplete = true;
            return;
        }
        const next = {...(this.counts ?? ZERO_TOKEN_COUNT)};
        for (const field of fields) next[field] += delta[field];
        if (fields.some(field => !Number.isSafeInteger(next[field]))) {
            this.incomplete = true;
            return;
        }
        this.counts = next;
    }

    tokenCount(): TokenCount | null {
        return this.counts;
    }

    accounting(interrupted = false) {
        return {
            version: 1,
            source: "codex/thread-token-usage-delta",
            scope: "root_thread_prompt",
            completeness: interrupted || this.incomplete || this.counts === null ? "partial" : "reported",
        };
    }
}
