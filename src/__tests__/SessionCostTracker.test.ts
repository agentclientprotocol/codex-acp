import {describe, expect, it} from "vitest";
import type {ModelPricingSnapshot} from "../PricingProvider";
import {SessionCostTracker} from "../SessionCostTracker";

const pricing: ModelPricingSnapshot = new Map([
    ["gpt-test", {
        standard: {
            shortContext: {input: 10, cachedInput: 2, output: 20},
            longContext: {input: 10, cachedInput: 2, output: 20},
        },
    }],
]);

describe("SessionCostTracker", () => {
    it("stops reporting cost when cache writes have no known rate", async () => {
        const tracker = new SessionCostTracker(pricing);
        const first = usage(100, 50, 25);
        const withWrites = {...usage(200, 100, 50), cacheWriteInputTokens: 30};
        const costs = [
            tracker.update(first, first, "gpt-test[medium]", false),
            tracker.update(withWrites, withWrites, "gpt-test[medium]", false),
            tracker.update(usage(300, 150, 75), first, "gpt-test[medium]", false),
        ];
        await expect(JSON.stringify(costs, null, 2)).toMatchFileSnapshot("data/cache-write-costs.json");
    });

    it("accumulates USD cost from cumulative token usage", () => {
        const tracker = new SessionCostTracker(pricing);

        expect(tracker.update(
            usage(1_000_000, 500_000, 250_000),
            usage(1_000_000, 500_000, 250_000),
            "gpt-test[medium]",
            false,
        )).toEqual({amount: 16, currency: "USD"});

        expect(tracker.update(
            usage(1_100_000, 550_000, 300_000),
            usage(100_000, 50_000, 50_000),
            "gpt-test[medium]",
            false,
        )).toEqual({amount: 18.1, currency: "USD"});
    });

    it("baselines existing usage when a session is resumed", () => {
        const tracker = new SessionCostTracker(pricing, true);

        expect(tracker.update(
            usage(1_000_000, 500_000, 250_000),
            usage(1_000_000, 500_000, 250_000),
            "gpt-test[medium]",
            false,
        )).toEqual({amount: 0, currency: "USD"});

        expect(tracker.update(
            usage(1_100_000, 550_000, 300_000),
            usage(100_000, 50_000, 50_000),
            "gpt-test[medium]",
            false,
        )).toEqual({amount: 2.1, currency: "USD"});
    });
});

function usage(inputTokens: number, cachedInputTokens: number, outputTokens: number) {
    return {
        totalTokens: inputTokens + cachedInputTokens + outputTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens: 0,
        cacheWriteInputTokens: 0,
    };
}
