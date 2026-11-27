import {describe, expect, it} from "vitest";
import type {RateLimitSnapshot} from "../app-server/v2";
import type {RateLimitsMap} from "../RateLimitsMap";
import {isoDuration, nextQuotaUpdatedAt, toQuotaPools} from "../QuotaSnapshot";

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
    return {
        normalModelSlug: null,
        limitId: "codex",
        limitName: null,
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

function map(...snapshots: RateLimitSnapshot[]): RateLimitsMap {
    return new Map(snapshots.map(s => [s.limitId!, {limitId: s.limitId!, limitName: s.limitName ?? s.limitId!, snapshot: s}]));
}

describe("QuotaSnapshot", () => {
    it("maps each bucket's windows and the account's credits to pools and meters", async () => {
        const pools = toQuotaPools(map(
            snapshot({
                primary: {usedPercent: 42, resetsAt: 1_791_288_000, windowDurationMins: 300},
                secondary: {usedPercent: 17, resetsAt: 1_791_709_200, windowDurationMins: 10080},
                credits: {hasCredits: true, unlimited: false, balance: "118.5"},
                individualLimit: {limit: "200", used: "50", remainingPercent: 75, resetsAt: 1_793_491_200},
            }),
            snapshot({
                limitId: "codex_fast",
                limitName: "Fast",
                primary: {usedPercent: 100, resetsAt: null, windowDurationMins: 45},
                rateLimitReachedType: "rate_limit_reached",
            }),
        ));

        await expect(JSON.stringify(pools, null, 2)).toMatchFileSnapshot("data/quota-pools.json");
    });

    it("reports only what Codex reported", () => {
        expect(toQuotaPools(map(snapshot({primary: {usedPercent: 5, resetsAt: null, windowDurationMins: null}}))))
            .toEqual([{id: "codex", meters: [{id: "primary", usedPercent: 5}]}]);
        expect(toQuotaPools(map(snapshot({credits: {hasCredits: false, unlimited: true, balance: null}}))))
            .toEqual([{id: "codex", meters: []}, {id: "credits", label: "Credits", state: "available", meters: []}]);
        expect(toQuotaPools(new Map())).toEqual([]);
    });

    it.each([[300, "PT5H"], [10080, "P7D"], [1440, "P1D"], [45, "PT45M"]])("writes %d minutes as %s", (minutes, iso) => {
        expect(isoDuration(minutes)).toBe(iso);
    });

    it("never repeats or decreases updatedAt, even when the clock does", () => {
        const first = nextQuotaUpdatedAt(Date.parse("2026-11-26T10:00:00.000Z"));
        const same = nextQuotaUpdatedAt(Date.parse("2026-11-26T10:00:00.000Z"));
        const earlier = nextQuotaUpdatedAt(Date.parse("2026-11-26T09:00:00.000Z"));
        expect([first, same, earlier]).toEqual([
            "2026-11-26T10:00:00.000Z",
            "2026-11-26T10:00:00.001Z",
            "2026-11-26T10:00:00.002Z",
        ]);
    });
});
