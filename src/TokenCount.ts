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
