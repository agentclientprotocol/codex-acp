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
                    cacheWriteInputTokens: 0,
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

describe("pricing table schema changes", () => {
    afterEach(() => vi.unstubAllGlobals());

    async function parse(markdown: string) {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(markdown)));
        return new OpenAiPricingProvider().getPricing([
            createTestModel({id: "gpt-6-astra", model: "gpt-6-astra"}),
        ]);
    }

    it("reads reordered columns with both cache-write durations and reproduces the reported chat", async () => {
        const markdown = await readFile(new URL("./data/astra-pricing-current.md", import.meta.url), "utf8");
        const pricing = await parse(markdown);
        expect(pricing.get("gpt-6-astra")).toEqual({
            standard: {
                shortContext: {input: 10, cachedInput: 1, output: 50},
                longContext: {input: 20, cachedInput: 2, output: 75},
            },
            fast: {
                shortContext: {input: 20, cachedInput: 2, output: 100},
                longContext: {input: 40, cachedInput: 4, output: 150},
            },
        });
        // One real update was priced at $8.0548 by the positional parser.
        const usage = {inputTokens: 175, cachedInputTokens: 161024, outputTokens: 148,
            totalTokens: 161347, cacheWriteInputTokens: 0, reasoningOutputTokens: 0};
        expect(new SessionCostTracker(pricing).update(usage, usage, "gpt-6-astra", false)?.amount)
            .toBeCloseTo(0.170174, 8);
    });

    it("fails closed for renamed, duplicate, missing or empty required columns", async () => {
        const markdown = await readFile(new URL("./data/astra-pricing-current.md", import.meta.url), "utf8");
        for (const changed of [
            markdown.replaceAll("Short context cached input", "Unknown rate"),
            markdown.replaceAll("Short context output", "Short context input"),
            markdown.replaceAll(" | Short context cached input", ""),
            markdown.replaceAll("$1.00", ""),
        ]) {
            expect((await parse(changed)).size).toBe(0);
        }
    });

    it("handles repeated sections but rejects conflicting rates for the same model", async () => {
        const markdown = await readFile(new URL("./data/astra-pricing-current.md", import.meta.url), "utf8");
        expect((await parse(markdown + "\n" + markdown)).size).toBe(1);
        expect((await parse(markdown + "\n" + markdown.replaceAll("$10.00", "$11.00"))).size).toBe(0);
    });
});
