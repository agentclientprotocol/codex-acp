import type {RateLimitSnapshot, RateLimitWindow} from "./app-server/v2";
import type {RateLimitsMap} from "./RateLimitsMap";

/**
 * `quota` — interim `_meta`-based ACP extension that pushes the account's rate limits as numbers.
 *
 * The shape follows the quotas & limits RFD (agentclientprotocol/agent-client-protocol#2316): a full
 * snapshot of pools and meters, with an `updatedAt` that orders snapshots. Until the RFD lands, the
 * agent pushes it as the `_quota/update` notification with the `sessionId` it applies to; afterwards the
 * same snapshot becomes the `quota_update` session update.
 *
 * The agent pushes when the Codex rate limits it knows for a session change (the app-server
 * `account/rateLimits/updated` push), and only on change.
 */
export const QUOTA_UPDATE_METHOD = "_quota/update";
export const QUOTA_META_KEY = "quota";

/** Open enum: clients render unknown values generically. */
export type QuotaPoolState = "available" | "exhausted" | "not_enabled" | "not_permitted" | "not_eligible";
/** Open enum: clients render unknown values generically. */
export type QuotaMeterStatus = "ok" | "warning" | "exceeded";

/** An exact amount: a decimal string, with the unit the provider reported. */
export interface Quantity {
    value: string;
    unit?: string;
}

export interface QuotaMeter {
    id: string;
    label?: string;
    /** Share of the limit used, 0 to 100. */
    usedPercent?: number;
    used?: Quantity;
    limit?: Quantity;
    remaining?: Quantity;
    /** ISO 8601 duration, such as `PT5H` or `P7D`. */
    window?: string;
    /** RFC 3339. */
    resetsAt?: string;
    status?: QuotaMeterStatus;
}

export interface QuotaPool {
    id: string;
    label?: string;
    state?: QuotaPoolState;
    meters: QuotaMeter[];
}

export interface QuotaSnapshot {
    /** RFC 3339: when the agent learned this data. Decides which of two snapshots is newer. */
    updatedAt: string;
    pools: QuotaPool[];
}

/** Params of the `_quota/update` notification. */
export type QuotaUpdateNotification = QuotaSnapshot & {
    sessionId: string;
}

/**
 * Capability advertised in the `initialize` response under `_meta.quota`: an empty object whose
 * presence means "this agent pushes `_quota/update`". The client only listens.
 */
export type QuotaCapability = {}

export function quotaCapability(): QuotaCapability {
    return {};
}

const USAGE_LIMIT_REACHED = new Set<string>([
    "rate_limit_reached",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
]);
const CREDITS_DEPLETED = new Set<string>([
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
]);

/**
 * The pools of the RFD's Codex mapping: one pool per rate-limit bucket (`limitId`) with its primary and
 * secondary windows as meters, and a `credits` pool when the account reports credits or a spend cap.
 * Only values Codex reported are set.
 */
export function toQuotaPools(rateLimits: RateLimitsMap): QuotaPool[] {
    const pools: QuotaPool[] = [];
    let credits: QuotaPool | null = null;
    for (const entry of rateLimits.values()) {
        const snapshot = entry.snapshot;
        const meters = [
            windowMeter("primary", snapshot.primary),
            windowMeter("secondary", snapshot.secondary),
        ].filter((meter): meter is QuotaMeter => meter !== null);
        const reached = snapshot.rateLimitReachedType;
        pools.push({
            id: entry.limitId,
            ...(entry.limitName !== entry.limitId && {label: entry.limitName}),
            ...(reached !== null && USAGE_LIMIT_REACHED.has(reached) && {state: "exhausted" as const}),
            meters,
        });
        credits ??= creditsPool(snapshot);
    }
    if (credits) pools.push(credits);
    return pools;
}

function windowMeter(id: string, window: RateLimitWindow | null): QuotaMeter | null {
    if (!window) return null;
    return {
        id,
        usedPercent: window.usedPercent,
        ...(window.windowDurationMins !== null && {window: isoDuration(window.windowDurationMins)}),
        ...(window.resetsAt !== null && {resetsAt: isoTime(window.resetsAt)}),
        ...(window.usedPercent >= 100 && {status: "exceeded" as const}),
    };
}

function creditsPool(snapshot: RateLimitSnapshot): QuotaPool | null {
    const {credits, individualLimit: cap} = snapshot;
    if (!credits && !cap) return null;
    const meters: QuotaMeter[] = [];
    if (credits && !credits.unlimited && credits.balance !== null) {
        meters.push({id: "balance", remaining: {value: credits.balance, unit: "credits"}});
    }
    if (cap) {
        meters.push({
            id: "spend_cap",
            label: "Monthly spend limit",
            usedPercent: 100 - cap.remainingPercent,
            used: {value: cap.used, unit: "credits"},
            limit: {value: cap.limit, unit: "credits"},
            window: "P1M",
            resetsAt: isoTime(cap.resetsAt),
        });
    }
    const reached = snapshot.rateLimitReachedType;
    const exhausted = (reached !== null && CREDITS_DEPLETED.has(reached)) || snapshot.spendControlReached === true;
    const state: QuotaPoolState | undefined = exhausted
        ? "exhausted"
        : credits && (credits.hasCredits || credits.unlimited) ? "available" : undefined;
    return {id: "credits", label: "Credits", ...(state && {state}), meters};
}

/** Minutes as an ISO 8601 duration: 300 is `PT5H`, 10080 is `P7D`. */
export function isoDuration(minutes: number): string {
    if (minutes > 0 && minutes % 1440 === 0) return `P${minutes / 1440}D`;
    if (minutes > 0 && minutes % 60 === 0) return `PT${minutes / 60}H`;
    return `PT${minutes}M`;
}

function isoTime(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toISOString();
}

let lastUpdatedAt = 0;

/**
 * The `updatedAt` of a new snapshot. It never decreases within the process, and moves on by at least
 * 1 ms, since the agent only pushes changed pools and two snapshots with the same time must be equal.
 */
export function nextQuotaUpdatedAt(nowMs: number = Date.now()): string {
    lastUpdatedAt = Math.max(nowMs, lastUpdatedAt + 1);
    return new Date(lastUpdatedAt).toISOString();
}
