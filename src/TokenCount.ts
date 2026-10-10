import type {Usage} from "@agentclientprotocol/sdk";
import type {TokenUsageBreakdown} from "./app-server/v2";

/**
 * Token usage information for a turn.
 * This interface decouples our API from Codex's internal types.
 *
 * [totalTokens]: total number of tokens used (the sum of all other fields)
 * [inputTokens]: number of fresh input tokens, neither read from nor written to the prompt cache
 * [cachedInputTokens]: number of input tokens read from the prompt cache
 * [cacheWriteInputTokens]: number of input tokens written to the prompt cache
 * [outputTokens]: number of output tokens (including reasoning output tokens)
 * [reasoningOutputTokens]: number of reasoning output tokens
 */
export interface TokenCount {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

/**
 * Maps Codex's TokenUsageBreakdown to our TokenCount interface.
 * This explicit mapping ensures compile-time errors if Codex changes their types.
 *
 * Codex's `inputTokens` is the whole prompt: it includes the tokens read from the cache
 * (`cachedInputTokens`) and the tokens written to it (`cacheWriteInputTokens`, reported by providers
 * such as Anthropic and zero otherwise). For example, a recorded request has 24098 input tokens of which
 * 23801 were cache reads and 294 cache writes, so 3 were fresh. Both are subtracted here so that fresh
 * input, cache reads and cache writes do not overlap. The result is clamped at 0, so inconsistent data
 * from a provider cannot produce a negative count.
 */
export function toTokenCount(usage: TokenUsageBreakdown): TokenCount {

    return {
        totalTokens: usage.totalTokens,
        inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
    };
}

/**
 * Maps our per-turn token breakdown to ACP PromptResponse usage fields.
 * Cached input tokens are reported as ACP cache reads, cache write tokens as ACP cache writes, and
 * reasoning output tokens are exposed through ACP's thoughtTokens field.
 */
export function toPromptUsage(tokenCount: TokenCount): Usage {
    return {
        totalTokens: tokenCount.totalTokens,
        inputTokens: tokenCount.inputTokens,
        cachedReadTokens: tokenCount.cachedInputTokens,
        cachedWriteTokens: tokenCount.cacheWriteInputTokens,
        outputTokens: tokenCount.outputTokens,
        thoughtTokens: tokenCount.reasoningOutputTokens,
    };
}

export const ZERO_TOKEN_COUNT: Readonly<TokenCount> = Object.freeze({
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
});

const TOKEN_COUNT_FIELDS = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
] as const satisfies ReadonlyArray<keyof TokenCount>;

function combine(a: TokenCount, b: TokenCount, op: (x: number, y: number) => number): TokenCount {
    const result = {} as TokenCount;
    for (const field of TOKEN_COUNT_FIELDS) result[field] = op(a[field], b[field]);
    return result;
}

function sameCount(a: TokenCount, b: TokenCount): boolean {
    return TOKEN_COUNT_FIELDS.every(field => a[field] === b[field]);
}

/**
 * Accumulates the token usage of one prompt from Codex's `thread/tokenUsage/updated` notifications.
 *
 * Codex reports the usage of the last model request (`last`) and the running total of the thread
 * (`total`). A turn can make many requests, so the usage of the prompt is the thread total at its end
 * minus the total when it started. When no start total is known, as in the first turn after a session is
 * created, forked or resumed (whose first total already includes the inherited history), or when the
 * total went back at any point of the prompt, the `last` values of the prompt's requests are summed instead.
 * An update that repeats the previous total is not a new request and is not counted again: Codex sends
 * its current usage again when a model request starts, with the rate limits of the response.
 * When the start total is unknown, such a repeated update can be the first one of the prompt, carrying the
 * history of a resumed or forked thread and its last request. A first update that arrives before the model
 * produced any output in this prompt is therefore taken as the start total instead of a request of the
 * prompt: the update of a request follows the output of that request.
 */
export class PromptTokenUsage {
    private startTotal: TokenCount | null;
    private previousTotal: TokenCount | null;
    private latestTotal: TokenCount | null = null;
    private summedLast: TokenCount | null = null;
    private totalWentBack = false;
    private modelOutputSeen = false;

    /** @param startTotal the thread total when the prompt started, or null when it is unknown. */
    constructor(startTotal: TokenCount | null) {
        this.startTotal = startTotal;
        this.previousTotal = startTotal;
    }

    /** Records that the model produced output in this prompt, so a later update is one of its requests. */
    observeModelOutput(): void {
        this.modelOutputSeen = true;
    }

    observe(total: TokenCount, last: TokenCount): void {
        const previous = this.previousTotal;
        if (previous !== null && sameCount(total, previous)) return;
        if (previous === null && !this.modelOutputSeen) {
            this.startTotal = total;
            this.previousTotal = total;
            return;
        }
        if (previous !== null && TOKEN_COUNT_FIELDS.some(field => total[field] < previous[field])) {
            this.totalWentBack = true;
        }
        this.summedLast = this.summedLast === null ? {...last} : combine(this.summedLast, last, (x, y) => x + y);
        this.previousTotal = total;
        this.latestTotal = total;
    }

    /** The usage of the prompt so far, or null when Codex reported none. */
    usage(): TokenCount | null {
        const start = this.startTotal;
        const latest = this.latestTotal;
        if (latest === null) return null;
        if (start !== null && !this.totalWentBack) {
            return combine(latest, start, (x, y) => x - y);
        }
        return this.summedLast;
    }
}
