import {readFile} from "node:fs/promises";
import {afterEach, describe, expect, it, vi} from "vitest";
import {OpenAiPricingProvider} from "../PricingProvider";
import {SessionCostTracker} from "../SessionCostTracker";
import {createTestModel} from "./acp-test-utils";

describe("Astra pricing", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("uses published standard and fast rates on both sides of the context threshold", async () => {
        const markdown = await readFile(new URL("./data/astra-pricing.md", import.meta.url), "utf8");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(markdown)));
        const pricing = await new OpenAiPricingProvider().getPricing([
            createTestModel({id: "gpt-6-astra", model: "gpt-6-astra"}),
        ]);
        const costs = [];
        for (const fast of [false, true]) {
            for (const inputTokens of [172_000, 172_001]) {
                const usage = {
                    inputTokens,
                    cachedInputTokens: 100_000,
                    outputTokens: 10_000,
                    reasoningOutputTokens: 0,
                    totalTokens: inputTokens + 110_000,
                };
                costs.push({
                    fast,
                    contextTokens: inputTokens + usage.cachedInputTokens,
                    cost: new SessionCostTracker(pricing).update(usage, usage, "gpt-6-astra[max]", fast),
                });
            }
        }
        await expect(JSON.stringify({pricing: Object.fromEntries(pricing), costs}, null, 2))
            .toMatchFileSnapshot("data/astra-costs.json");
    });
});
