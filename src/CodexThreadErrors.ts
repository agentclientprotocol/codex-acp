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
