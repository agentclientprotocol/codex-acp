import type {Account, AccountUpdatedNotification} from "./app-server/v2";
import type {AuthMode} from "./app-server/AuthMode";
import type {PlanType} from "./app-server/PlanType";

/**
 * `authStatus` — interim `_meta`-based ACP extension that reports the auth
 * identity of the connection (the agent process serving this ACP connection).
 *
 * Push only. There is one carrier, connection-scoped and never per session: the
 * notification `_auth/status_update` with `{authStatus}`. The client sends
 * nothing; there is no request method to pull the value.
 *
 * The agent pushes:
 * - once after `initialize`, as soon as it knows its identity, including
 *   `none`. That first push is unconditional and is sent after the `initialize`
 *   response;
 * - on every change it observes afterwards, and only on change
 *   ({@link sameAuthStatus}): a completed `authenticate` or `logout`, each
 *   session create/fork/load (a refused session reports too — the client must
 *   know which account was refused), and the app-server `account/updated` push,
 *   which the agent maps straight onto a status ({@link fromAccountUpdated}).
 *
 * `account/updated` is the free freshness channel for a login or a logout made
 * in another terminal, so there are no timers here and no re-read at a turn
 * boundary.
 *
 * An agent that cannot learn its identity pushes nothing, and the client shows
 * "not reported". `kind: "none"` is not that case: it is a known logged-out
 * state, and it is reported.
 *
 * The payload moves to first-class protocol fields once the upstream
 * auth-identity RFD lands; this extension is retired then.
 */
export const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";
export const AUTH_STATUS_META_KEY = "authStatus";

/** Category of the credential the agent uses. Clients tolerate unknown values. */
export type AuthStatusKind = "account" | "api_key" | "gateway" | "external" | "none";

export interface AuthStatusAccount {
    email?: string;
    organization?: string;
    /** Vendor plan/license string, not normalized. */
    plan?: string;
}

export interface AuthStatus {
    kind: AuthStatusKind;
    /** Human-readable, agent-defined; usable as a UI string on its own. */
    label: string;
    /**
     * Optional secondary line (gateway provider, key source, ...). Clients
     * render `label` first and fall back to `account.email` when there is no
     * detail.
     */
    detail?: string;
    account?: AuthStatusAccount;
    /** Vendor-namespaced extras. */
    vendor?: Record<string, unknown>;
}

/** Params of the `_auth/status_update` notification. */
export type AuthStatusUpdateNotification = {
    authStatus: AuthStatus;
}

/**
 * Capability advertised in the `initialize` response under
 * `agentCapabilities._meta.authStatus`: an empty object whose presence means
 * "this agent pushes its identity". It is never a status payload, and it gates
 * nothing the client sends — the client only listens.
 */
export type AuthStatusCapability = {}

export function authStatusCapability(): AuthStatusCapability {
    return {};
}

const NOT_LOGGED_IN_LABEL = "Not logged in";
const DEFAULT_GATEWAY_LABEL = "Custom model gateway";

const PLAN_DISPLAY_NAMES: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
};

/**
 * Display name for a Codex plan; unknown raw values are capitalized so the
 * label stays truthful when the enum grows.
 */
export function planTypePresentable(planType: PlanType | string | null | undefined): string | null {
    if (!planType || planType === "unknown") {
        return null;
    }
    return PLAN_DISPLAY_NAMES[planType] ?? capitalize(planType);
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function chatGptLabel(planType: PlanType | null | undefined): string {
    const plan = planTypePresentable(planType);
    return plan === null ? "ChatGPT" : `ChatGPT ${plan}`;
}

/**
 * Agent-owned gateway routing: the `gateway` auth method, or Codex's own config.
 * `label` is the type line and stays constant; the provider name is the
 * specifics, so it rides in `detail` (line 2) the way every other kind does.
 */
export function gatewayStatus(providerName?: string | null): AuthStatus {
    const detail = typeof providerName === "string" && providerName.trim().length > 0
        ? providerName.trim()
        : undefined;
    return {
        kind: "gateway",
        label: DEFAULT_GATEWAY_LABEL,
        ...(detail === undefined ? {} : {detail}),
    };
}

export function unauthenticatedStatus(): AuthStatus {
    return {
        kind: "none",
        label: NOT_LOGGED_IN_LABEL,
    };
}

/** Maps the app-server `account/read` result. */
export function fromAccount(account: Account | null): AuthStatus {
    if (account === null) {
        return unauthenticatedStatus();
    }
    switch (account.type) {
        case "chatgpt": {
            const accountInfo: AuthStatusAccount = {};
            if (account.email) {
                accountInfo.email = account.email;
            }
            if (account.planType) {
                accountInfo.plan = account.planType;
            }
            return {
                kind: "account",
                label: chatGptLabel(account.planType),
                ...(Object.keys(accountInfo).length > 0 ? {account: accountInfo} : {}),
            };
        }
        case "apiKey":
            return {
                kind: "api_key",
                label: "OpenAI API key",
            };
        case "amazonBedrock":
            return {
                kind: "external",
                label: "AWS Bedrock",
            };
    }
}

/**
 * Maps the coarser `account/updated` push, which carries no email. The last
 * known email is kept only when the account kind did not change; otherwise it
 * is dropped until the next full `account/read`.
 */
export function fromAccountUpdated(
    notification: AccountUpdatedNotification,
    previous?: AuthStatus | null,
): AuthStatus {
    const authMode: AuthMode | null = notification.authMode;
    if (authMode === null) {
        return unauthenticatedStatus();
    }
    switch (authMode) {
        case "chatgpt":
        case "chatgptAuthTokens": {
            const status: AuthStatus = {
                kind: "account",
                label: chatGptLabel(notification.planType),
            };
            const accountInfo: AuthStatusAccount = {};
            const previousEmail = previous?.kind === "account" ? previous.account?.email : undefined;
            if (previousEmail) {
                accountInfo.email = previousEmail;
            }
            if (notification.planType) {
                accountInfo.plan = notification.planType;
            }
            if (Object.keys(accountInfo).length > 0) {
                status.account = accountInfo;
            }
            return status;
        }
        case "apikey":
            return {
                kind: "api_key",
                label: "OpenAI API key",
            };
        case "personalAccessToken":
            return {
                kind: "api_key",
                label: "OpenAI personal access token",
            };
        case "bedrockApiKey":
        case "bedrockAccessKeys":
            return {
                kind: "external",
                label: "AWS Bedrock",
            };
        case "agentIdentity":
            return {
                kind: "external",
                label: "Agent identity",
            };
        case "headers":
            return gatewayStatus();
    }
}

/**
 * Do two payloads carry the same information? Compares every rendered field,
 * so a richer read of the same login is NOT the same. Callers use it to drop a
 * push that would tell the client nothing new: the identity is read on many
 * occasions (`initialize`, each session create, each `account/updated`) and
 * almost all of them see the login that is already reported.
 *
 * A missing `previous` means "nothing reported yet", which never equals a payload.
 */
export function sameAuthStatus(previous: AuthStatus | null | undefined, next: AuthStatus): boolean {
    if (!previous) {
        return false;
    }
    return previous.kind === next.kind
        && previous.label === next.label
        && previous.detail === next.detail
        && previous.account?.email === next.account?.email
        && previous.account?.organization === next.account?.organization
        && previous.account?.plan === next.account?.plan
        // Vendor extras are an open bag, so compare them structurally. Both
        // sides are built here from the same key order, so a string compare is
        // enough and costs nothing on the usual `undefined`/`undefined` pair.
        && JSON.stringify(previous.vendor) === JSON.stringify(next.vendor);
}
