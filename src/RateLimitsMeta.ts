import type {PlanType} from "./app-server/PlanType";
import type {RateLimitReachedType, RateLimitSnapshot} from "./app-server/v2";

/**
 * `rateLimits` — interim `_meta`-based ACP extension that pushes the usage
 * windows of the account this connection bills to, so a client can show how
 * much of the 5-hour and weekly window is spent and, when a turn is refused
 * for a spent window, knows when that window clears.
 *
 * Push only, connection-scoped: the windows belong to the account, not to a
 * session, exactly like `authStatus`. The carrier is the notification
 * `_account/rate_limits_update` with `{rateLimits}`. The client sends nothing.
 * The agent observes the app-server's account notification once, at the
 * connection, before it fans out to the per-session handlers, so the push is
 * ordered and never duplicated by the number of open sessions.
 *
 * The agent pushes on every app-server `account/rateLimits/updated` whose
 * merged payload for that `limitId` differs from the last one pushed for it
 * ({@link sameRateLimits}). That notification is sparse ("merge available
 * values into the most recent snapshot"), so the agent merges first — against
 * a connection-level baseline per `limitId`, never per-session state, which is
 * reset on every session create while the account notification fans out to
 * every session's handler — and pushes the complete picture; a client never
 * needs `account/rateLimits/read`. A push replaces the client's state for that
 * `limitId` only.
 *
 * The moment that matters most is a refused prompt: Codex reports the spent
 * window on `account/rateLimits/updated` and fails the turn with
 * `codexErrorInfo: "usageLimitExceeded"`, and that error carries no reset
 * time. This push does — `primary.resetsAt` / `secondary.resetsAt` — which is
 * what lets a client park the session and resume it when the window clears
 * instead of guessing. The two are separate messages with no ordering promise.
 *
 * Field names and units follow codex app-server's `RateLimitSnapshot` so a
 * reader of either doc reads the other. Spend-control and credit balances are
 * deliberately not forwarded: they are billing state, not usage windows.
 *
 * The payload moves to first-class protocol fields if ACP standardises
 * rate-limit reporting; this extension is retired then.
 */
export const RATE_LIMITS_UPDATE_METHOD = "_account/rate_limits_update";
export const RATE_LIMITS_META_KEY = "rateLimits";

/** One rolling usage window. */
export interface RateLimitsWindow {
    /** Share of the window already spent, `0`–`100`. */
    usedPercent: number;
    /** Window length in minutes (`300` for the 5-hour window, `10080` for the
     *  weekly one); `null` when the backend did not report it. */
    windowDurationMins: number | null;
    /** Unix time in SECONDS at which the window clears; `null` when the
     *  backend did not report it. */
    resetsAt: number | null;
}

export interface RateLimits {
    /** Stable id of the limit these windows belong to (`"codex"` for the
     *  account's ordinary usage limit). */
    limitId: string;
    /** Human-readable name of the limit, when the backend names it. */
    limitName: string | null;
    /** For a model-specific limit, the model whose quota these windows are;
     *  `null` for the account's ordinary limit. This is how a client ties a
     *  refusal to the windows it should schedule against. */
    normalModelSlug: string | null;
    primary: RateLimitsWindow | null;
    secondary: RateLimitsWindow | null;
    /** The reached state as reported on the latest update: non-null when the
     *  backend reported that it is refusing turns on this limit, and why;
     *  `null` when the latest update reported none. Clients tolerate values
     *  they do not recognise. */
    rateLimitReachedType: RateLimitReachedType | null;
    /** Vendor plan string, not normalised. */
    planType: PlanType | null;
}

/** Params of the `_account/rate_limits_update` notification. */
export type RateLimitsUpdateNotification = {
    rateLimits: RateLimits;
}

/**
 * Capability advertised in the `initialize` response under
 * `agentCapabilities._meta.rateLimits`: an empty object whose presence means
 * "this agent pushes its usage windows". It never carries a payload.
 */
export type RateLimitsCapability = {}

export function rateLimitsCapability(): RateLimitsCapability {
    return {};
}

/** The pushed subset of a merged app-server snapshot. */
export function toRateLimits(limitId: string, snapshot: RateLimitSnapshot): RateLimits {
    return {
        limitId,
        limitName: snapshot.limitName ?? null,
        normalModelSlug: snapshot.normalModelSlug ?? null,
        primary: toWindow(snapshot.primary),
        secondary: toWindow(snapshot.secondary),
        rateLimitReachedType: snapshot.rateLimitReachedType ?? null,
        planType: snapshot.planType ?? null,
    };
}

function toWindow(window: RateLimitSnapshot["primary"]): RateLimitsWindow | null {
    if (window === null || window === undefined) {
        return null;
    }
    return {
        usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins ?? null,
        resetsAt: window.resetsAt ?? null,
    };
}

export function sameRateLimits(a: RateLimits | null, b: RateLimits): boolean {
    return a !== null
        && a.limitId === b.limitId
        && a.limitName === b.limitName
        && a.normalModelSlug === b.normalModelSlug
        && a.rateLimitReachedType === b.rateLimitReachedType
        && a.planType === b.planType
        && sameWindow(a.primary, b.primary)
        && sameWindow(a.secondary, b.secondary);
}

function sameWindow(a: RateLimitsWindow | null, b: RateLimitsWindow | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.usedPercent === b.usedPercent
        && a.windowDurationMins === b.windowDurationMins
        && a.resetsAt === b.resetsAt;
}
