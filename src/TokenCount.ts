import type {Usage} from "@agentclientprotocol/sdk";
import type {TokenUsageBreakdown} from "./app-server/v2";

/**
 * Token usage information for a turn.
 * This interface decouples our API from Codex's internal types.
 *
 * [totalTokens]: total number of tokens used (the sum of all other fields)
 * [inputTokens]: number of non-cached input tokens
 * [cachedInputTokens]: number of cached input tokens
 * [outputTokens]: number of output tokens (including reasoning output tokens)
 * [reasoningOutputTokens]: number of reasoning output tokens
 */
export interface TokenCount {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

/**
 * Returns the category-by-category usage added to a cumulative token count.
 * Each category is clamped independently because an upstream counter may be
 * reset or corrected between snapshots.
 */
export function subtractTokenCounts(
    current: TokenCount | null,
    previous: TokenCount | null,
): TokenCount | null {
    if (current == null) {
        return null;
    }

    const difference = (currentValue: number, previousValue: number): number =>
        Math.max(0, currentValue - previousValue);
    const baseline = previous ?? {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
    };

    const inputTokens = difference(current.inputTokens, baseline.inputTokens);
    const cachedInputTokens = difference(current.cachedInputTokens, baseline.cachedInputTokens);
    const outputTokens = difference(current.outputTokens, baseline.outputTokens);
    const reasoningOutputTokens = Math.min(
        outputTokens,
        difference(current.reasoningOutputTokens, baseline.reasoningOutputTokens),
    );

    return {
        totalTokens: inputTokens + cachedInputTokens + outputTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
    };
}

/**
 * Maps Codex's TokenUsageBreakdown to our TokenCount interface.
 * This explicit mapping ensures compile-time errors if Codex changes their types.
 * Note: Codex includes cached input tokens in the input token count, so they are subtracted here.
 */
export function toTokenCount(usage: TokenUsageBreakdown): TokenCount {

    return {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens - usage.cachedInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
    };
}

/**
 * Maps our per-turn token breakdown to ACP PromptResponse usage fields.
 * Cached input tokens are reported as ACP cache reads, and reasoning output
 * tokens are exposed through ACP's thoughtTokens field.
 */
export function toPromptUsage(tokenCount: TokenCount): Usage {
    return {
        totalTokens: tokenCount.totalTokens,
        inputTokens: tokenCount.inputTokens,
        cachedReadTokens: tokenCount.cachedInputTokens,
        outputTokens: tokenCount.outputTokens,
        thoughtTokens: tokenCount.reasoningOutputTokens,
    };
}
