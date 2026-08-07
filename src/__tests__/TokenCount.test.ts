import {describe, expect, it} from "vitest";
import {subtractTokenCounts} from "../TokenCount";

describe("subtractTokenCounts", () => {
    it("clamps cumulative counter decreases and keeps the total consistent", () => {
        expect(subtractTokenCounts(
            {
                totalTokens: 900,
                inputTokens: 650,
                cachedInputTokens: 100,
                outputTokens: 150,
                reasoningOutputTokens: 20,
            },
            {
                totalTokens: 1000,
                inputTokens: 600,
                cachedInputTokens: 200,
                outputTokens: 200,
                reasoningOutputTokens: 40,
            },
        )).toEqual({
            totalTokens: 50,
            inputTokens: 50,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
        });
    });
});
