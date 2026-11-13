import {describe, expect, it} from "vitest";
import {PromptTokenUsage, toPromptUsage, toTokenCount, type TokenCount} from "../TokenCount";

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

function count(totalTokens: number): TokenCount {
    return {
        totalTokens,
        inputTokens: totalTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
    };
}

describe("PromptTokenUsage", () => {
    it("is null before Codex reports usage", () => {
        expect(new PromptTokenUsage(count(1000)).usage()).toBeNull();
    });

    it("uses the total difference when the start is known, even if an intermediate update is missing", () => {
        const usage = new PromptTokenUsage(count(1000));
        usage.observe(count(1000), count(100));
        expect(usage.usage()).toBeNull();

        usage.observe(count(1600), count(200));
        usage.observe(count(1600), count(200));

        expect(usage.usage()).toEqual(count(600));
    });

    it("uses inherited history as the baseline without counting it as a new request", () => {
        const usage = new PromptTokenUsage(null);
        usage.observe(count(1000), count(100));
        usage.observe(count(1000), count(100));
        expect(usage.usage()).toBeNull();

        usage.observeModelOutput();
        usage.observe(count(1600), count(200));

        expect(usage.usage()).toEqual(count(600));
    });

    it("sums requests without a baseline and ignores repeated totals", () => {
        const usage = new PromptTokenUsage(null);
        usage.observeModelOutput();
        usage.observe(count(11000), count(1000));
        usage.observe(count(11000), count(1000));
        usage.observe(count(11500), count(500));

        expect(usage.usage()).toEqual(count(1500));
    });

    it("distinguishes a reported zero from missing usage", () => {
        const usage = new PromptTokenUsage(null);
        usage.observeModelOutput();
        usage.observe(count(0), count(0));

        expect(usage.usage()).toEqual(count(0));
    });

    it("sums the requests once the total went back, even after it passes the start again", () => {
        const usage = new PromptTokenUsage(count(1000));

        usage.observe(count(500), count(500));
        usage.observe(count(1500), count(1000));

        expect(usage.usage()?.totalTokens).toBe(1500);
    });
});
