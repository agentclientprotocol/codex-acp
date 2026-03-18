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
