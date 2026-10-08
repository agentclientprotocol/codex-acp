import {describe, expect, it} from "vitest";
import {toPromptUsage, toTokenCount} from "../TokenCount";

describe("toTokenCount", () => {
    it("separates cache reads and cache writes from fresh input", () => {
        // A request recorded by Codex with an Anthropic-style provider: `inputTokens` is the whole prompt,
        // which includes both the tokens read from the cache and the tokens written to it.
        const count = toTokenCount({
            totalTokens: 24210,
            inputTokens: 24098,
            cachedInputTokens: 23801,
            cacheWriteInputTokens: 294,
            outputTokens: 112,
            reasoningOutputTokens: 40,
        });

        expect(count).toEqual({
            totalTokens: 24210,
            inputTokens: 3,
            cachedInputTokens: 23801,
            cacheWriteInputTokens: 294,
            outputTokens: 112,
            reasoningOutputTokens: 40,
        });
    });

    it("never reports negative fresh input", () => {
        const count = toTokenCount({
            totalTokens: 150,
            inputTokens: 100,
            cachedInputTokens: 80,
            cacheWriteInputTokens: 40,
            outputTokens: 50,
            reasoningOutputTokens: 0,
        });

        expect(count.inputTokens).toBe(0);
    });
});

describe("toPromptUsage", () => {
    it("reports cache writes as ACP cachedWriteTokens", () => {
        const usage = toPromptUsage(toTokenCount({
            totalTokens: 24075,
            inputTokens: 23932,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 23801,
            outputTokens: 143,
            reasoningOutputTokens: 57,
        }));

        expect(usage).toEqual({
            totalTokens: 24075,
            inputTokens: 131,
            cachedReadTokens: 0,
            cachedWriteTokens: 23801,
            outputTokens: 143,
            thoughtTokens: 57,
        });
    });
});
