/**
 * Classifiers for the Codex app-server errors that ACP has to translate into
 * something other than a bare `-32603 Internal error`.
 *
 * Codex reports these as plain JSON-RPC error messages with no machine-readable
 * discriminator, so matching on the message text is the only option; each
 * predicate keeps the match anchored on the stable part of the phrasing.
 */

import {RequestError} from "@agentclientprotocol/sdk";

function errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    if (err !== null && typeof err === "object" && "message" in err) {
        return String((err as { message: unknown }).message);
    }
    return "";
}

/**
 * Codex materializes a thread's rollout file lazily, on the thread's first
 * user message. `thread/resume` and `thread/archive` read that file, so both
 * fail this way for a thread that was started but never prompted -- and for a
 * thread id Codex has simply never seen.
 */
export function isMissingRolloutError(err: unknown): boolean {
    return errorText(err).includes("no rollout found for thread id");
}

/**
 * `thread/unarchive` answers this for a thread that has no archived rollout:
 * a thread that is not archived, or one Codex has never seen.
 */
export function isMissingArchivedRolloutError(err: unknown): boolean {
    return errorText(err).includes("no archived rollout found for thread id");
}

/**
 * `thread/read` answers this for a thread id that is well-formed but not
 * currently loaded in the app-server process.
 */
export function isThreadNotLoadedError(err: unknown): boolean {
    return errorText(err).includes("thread not loaded:");
}

/**
 * `mcpServerStatus/list` answers this for a thread id that is well-formed but
 * unknown to the app-server process.
 */
export function isThreadNotFoundError(err: unknown): boolean {
    return errorText(err).includes("thread not found:");
}

/**
 * Codex thread ids are UUIDs, so anything else is rejected before lookup. ACP
 * session ids are opaque strings, so a client is free to send an id Codex
 * cannot even parse.
 */
export function isInvalidThreadIdError(err: unknown): boolean {
    const text = errorText(err);
    return text.includes("invalid thread id:") || text.includes("invalid session id:");
}

/**
 * `turn/interrupt` answers this both for a turn that has already finished and
 * for one Codex has not registered as interruptible yet -- a `session/cancel`
 * that lands in the window between the turn's first streamed event and that
 * registration.
 */
export function isNoActiveTurnError(err: unknown): boolean {
    return errorText(err).includes("no active turn to interrupt");
}

/**
 * True when the error means "Codex has no persisted thread under this id" for
 * any reason -- unparseable id, unknown id, or an id whose rollout was never
 * materialized.
 */
export function isUnknownThreadError(err: unknown): boolean {
    return isMissingRolloutError(err) || isThreadNotLoadedError(err) || isInvalidThreadIdError(err);
}

/**
 * `thread/resume` answers this when another Codex app-server -- the Codex
 * app, the CLI or an IDE extension -- has the thread loaded. That process
 * holds an exclusive lock on the thread's rollout until it unloads the
 * thread, which can be later than the moment its tab closes. The match is
 * not anchored, so a wrapped message still counts.
 */
export function isThreadActiveWriterError(err: unknown): boolean {
    return /\bthread \S+ already has an active writer\b/.test(errorText(err));
}

/**
 * The ACP error for a thread that another Codex client has loaded. The
 * `reason` field is stable, so a client can recognise the case without
 * parsing the message.
 */
export function threadActiveWriterRequestError(threadId: string, err: unknown): RequestError {
    return RequestError.invalidRequest(
        {reason: "thread_active_writer", threadId, details: errorText(err)},
        "This Codex session is in use by another Codex client (the Codex app, the CLI or an IDE extension). Close the session there or quit that client, then try again.",
    );
}

/** The JSON-RPC code of ACP `ResourceNotFound`. */
export const RESOURCE_NOT_FOUND_CODE = -32002;

/** The ACP error for a session id that Codex has no thread for. */
export function sessionNotFoundRequestError(sessionId: string): RequestError {
    return new RequestError(RESOURCE_NOT_FOUND_CODE, `Session not found: ${sessionId}`, {sessionId});
}

/** The `data.reason` of the error for a request that an archived session does not take. */
export const SESSION_ARCHIVED_REASON = "archived";

/** The ACP error for a request that Codex refuses because the thread is archived. */
export function sessionArchivedRequestError(sessionId: string): RequestError {
    return RequestError.invalidRequest(
        {reason: SESSION_ARCHIVED_REASON, sessionId},
        `Session is archived: ${sessionId}`,
    );
}

/** The JSON-RPC code of an app-server internal error. */
const INTERNAL_ERROR_CODE = -32603;

/**
 * The `account/read` errors of the app-server workspace routing discovery that say nothing about the login.
 * The texts come from `WorkspaceRoutingError` in codex-rs/app-server `account_processor/workspace_routing.rs`
 * (rust-v0.159.1). The discovery runs only for a ChatGPT login that the app-server already holds.
 * It makes a network call to the ChatGPT backend (`accounts/check`).
 *
 * - `DiscoveryFailed` covers every failure of `accounts/check` except a 401: no connection, a network policy
 *   denial, a bad JSON answer, and every other HTTP status. The text has no status, so a 403 of a deactivated
 *   account or of a removed workspace also matches. The session then opens, and the first turn fails with
 *   the real error of the backend.
 * - `DiscoveryTimeout` is the 15 s limit of the whole read. It also covers the config load, the wait for
 *   another discovery of the same account, and the token refresh after a 401. The config load is local and
 *   fast, the other two are network calls.
 *
 * Two texts of the enum are not in the set. `DiscoveryCancelled` comes only from a closed semaphore, and the
 * app-server never closes it. `Shutdown` comes from an app-server that stops, so it is not a network failure.
 */
const ACCOUNT_READ_UNAVAILABLE_MESSAGES = new Set([
    "workspace routing discovery failed",
    "workspace routing discovery timed out",
]);

/**
 * The `account/read` errors that say that the login does not work, so the user must log in again.
 * - `DiscoveryUnauthorized`: the backend refused the token with 401, also after a token refresh.
 * - `MissingWorkspace`: the selected workspace of the login is not in the accounts of the user.
 * - `MissingAccountId`: the ChatGPT login has no account id.
 */
const ACCOUNT_READ_AUTH_FAILURE_MESSAGES = new Set([
    "workspace routing discovery unauthorized (401)",
    "selected workspace missing from routing discovery",
    "workspace routing requires a ChatGPT account id",
]);

/** The `account/read` error when another client logged in or out while the read ran (`AccountChanged`). */
const ACCOUNT_READ_ACCOUNT_CHANGED_MESSAGE = "account changed during workspace routing discovery";

/** The text of an app-server internal error, or `null` for another error. */
function internalErrorText(err: unknown): string | null {
    if (err === null || typeof err !== "object" || (err as {code?: unknown}).code !== INTERNAL_ERROR_CODE) {
        return null;
    }
    return errorText(err);
}

/**
 * True when `account/read` failed without an answer about the login, because the ChatGPT backend did not answer.
 * Such a failure does not mean "not logged in". It also tells that the app-server holds a ChatGPT login,
 * because only such a login runs the discovery. The app-server sends the error as an internal error with only
 * the text of the routing error, so the match needs the code and the whole message. Another phrasing does not
 * match, and the error then stays an error, as before.
 */
export function isAccountReadUnavailableError(err: unknown): boolean {
    const text = internalErrorText(err);
    return text !== null && ACCOUNT_READ_UNAVAILABLE_MESSAGES.has(text);
}

/**
 * True when `account/read` failed because the login does not work, see {@link ACCOUNT_READ_AUTH_FAILURE_MESSAGES}.
 * The agent then needs a new login, as for a missing login.
 */
export function isAccountReadAuthFailureError(err: unknown): boolean {
    const text = internalErrorText(err);
    return text !== null && ACCOUNT_READ_AUTH_FAILURE_MESSAGES.has(text);
}

/** True when `account/read` failed because another client logged in or out while the read ran. */
export function isAccountReadAccountChangedError(err: unknown): boolean {
    return internalErrorText(err) === ACCOUNT_READ_ACCOUNT_CHANGED_MESSAGE;
}
