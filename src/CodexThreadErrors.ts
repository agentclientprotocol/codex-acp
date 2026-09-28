/**
 * Classifiers for the Codex app-server errors that ACP has to translate into
 * something other than a bare `-32603 Internal error`.
 *
 * Codex reports these as plain JSON-RPC error messages with no machine-readable
 * discriminator, so matching on the message text is the only option; each
 * predicate keeps the match anchored on the stable part of the phrasing.
 */

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
 * `thread/read` answers this for a thread id that is well-formed but not
 * currently loaded in the app-server process.
 */
export function isThreadNotLoadedError(err: unknown): boolean {
    return errorText(err).includes("thread not loaded:");
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
 * `turn/interrupt` answers this when Codex has since moved on to another turn --
 * most commonly a review's child turn -- registered after the id we sent. The
 * message names the turn Codex considers active, which is the id to retry with.
 */
export function parseExpectedActiveTurnMismatch(err: unknown): {expected: string, found: string} | null {
    const match = errorText(err).match(/expected active turn id (\S+) but found (\S+)/);
    return match ? {expected: match[1]!, found: match[2]!} : null;
}

/**
 * True when the error means "Codex has no persisted thread under this id" for
 * any reason -- unparseable id, unknown id, or an id whose rollout was never
 * materialized.
 */
export function isUnknownThreadError(err: unknown): boolean {
    return isMissingRolloutError(err) || isThreadNotLoadedError(err) || isInvalidThreadIdError(err);
}
