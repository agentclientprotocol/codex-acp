import type {GetAccountRateLimitsResponse, RateLimitSnapshot} from "./app-server/v2";

export type RateLimitEntry = {
    limitId: string;
    limitName: string;
    snapshot: RateLimitSnapshot;
};

export type RateLimitsMap = Map<string, RateLimitEntry>;

function rateLimitId(snapshot: RateLimitSnapshot, fallback = "codex"): string {
    return snapshot.limitId ?? fallback;
}

export function createRateLimitsMap(response: GetAccountRateLimitsResponse): RateLimitsMap {
    const result: RateLimitsMap = new Map();
    const snapshots = Object.entries(response.rateLimitsByLimitId ?? {})
        .filter((entry): entry is [string, RateLimitSnapshot] => entry[1] !== undefined);

    if (snapshots.length === 0) {
        snapshots.push([rateLimitId(response.rateLimits), response.rateLimits]);
    }

    for (const [fallbackId, snapshot] of snapshots) {
        const limitId = rateLimitId(snapshot, fallbackId);
        result.set(limitId, {
            limitId,
            limitName: snapshot.limitName ?? limitId,
            snapshot,
        });
    }
    return result;
}

export function mergeRateLimitSnapshot(
    previous: RateLimitSnapshot,
    update: RateLimitSnapshot,
): RateLimitSnapshot {
    return {
        ...update,
        limitId: update.limitId ?? "codex",
        credits: update.credits ?? previous.credits,
        individualLimit: update.individualLimit ?? previous.individualLimit,
        spendControlReached: update.spendControlReached ?? previous.spendControlReached,
        planType: update.planType ?? previous.planType,
    };
}
