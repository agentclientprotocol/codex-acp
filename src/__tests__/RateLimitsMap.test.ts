import {describe, expect, it} from "vitest";
import type {RateLimitSnapshot} from "../app-server/v2";
import {createRateLimitsMap, mergeRateLimitSnapshot} from "../RateLimitsMap";

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
    return {
        limitId: "codex",
        limitName: "Codex",
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: null,
        rateLimitReachedType: null,
        ...overrides,
    };
}

describe("RateLimitsMap", () => {
    it("uses every bucket from the complete rate-limit response", () => {
        const codex = snapshot({limitId: "codex"});
        const fast = snapshot({limitId: "fast", limitName: "Fast"});

        const result = createRateLimitsMap({
            rateLimits: codex,
            rateLimitsByLimitId: {codex, fast},
            rateLimitResetCredits: null,
            accountId: null,
            rateLimitUpsell: null,
        });

        expect([...result.keys()]).toEqual(["codex", "fast"]);
    });

    it("does not erase known fields when applying a sparse update", () => {
        const previous = snapshot({
            primary: {usedPercent: 15, resetsAt: 100, windowDurationMins: 300},
            credits: {hasCredits: true, unlimited: false, balance: "10"},
        });
        const update = snapshot({
            limitName: null,
            primary: null,
            secondary: {usedPercent: 25, resetsAt: 200, windowDurationMins: 10080},
        });

        expect(mergeRateLimitSnapshot(previous, update)).toEqual({
            ...previous,
            secondary: update.secondary,
        });
    });
});
