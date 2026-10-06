/**
 * The thread changes behind the `sessionIndex` requests: archive, unarchive
 * and delete. Each is idempotent where Codex is not.
 */

import path from "node:path";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {
    isInvalidThreadIdError,
    isMissingArchivedRolloutError,
    isMissingRolloutError,
    isThreadActiveWriterError,
    isThreadNotFoundError,
    isUnknownThreadError,
    sessionNotFoundRequestError,
    threadActiveWriterRequestError,
} from "./CodexThreadErrors";
import {logger} from "./Logger";

/** `done`: Codex changed the thread. `unchanged`: it already was in that state. `missing`: Codex has no such thread. */
export type ThreadChangeOutcome = "done" | "unchanged" | "missing";

/** The directory under CODEX_HOME where Codex moves the rollout of an archived thread. */
const ARCHIVED_SESSIONS_DIR = "archived_sessions";

/** True when the error says that Codex has no thread under this id. */
export function isMissingThreadError(err: unknown): boolean {
    return isUnknownThreadError(err) || isThreadNotFoundError(err);
}

/**
 * The ACP error of a failed `sessionIndex` request: `thread_active_writer` when another Codex process holds
 * the thread, `-32002` when Codex has no such thread, and the error itself otherwise.
 */
export function sessionIndexRequestError(sessionId: string, err: unknown): unknown {
    if (isThreadActiveWriterError(err)) return threadActiveWriterRequestError(sessionId, err);
    if (isMissingThreadError(err)) return sessionNotFoundRequestError(sessionId);
    return err;
}

/**
 * Archives or unarchives a thread.
 *
 * Codex fails `thread/archive` with "no rollout found" for a thread that is already archived, and
 * `thread/unarchive` with "no archived rollout found" for one that is not archived. Both errors also mean
 * "no such thread". `thread/read` tells the cases apart: it finds archived threads too, and `Thread.path` of
 * an archived thread is under `<CODEX_HOME>/archived_sessions/`.
 */
export async function setThreadArchived(
    client: CodexAppServerClient,
    threadId: string,
    archived: boolean,
    codexHome: string | null,
): Promise<ThreadChangeOutcome> {
    try {
        if (archived) {
            await client.threadArchive({threadId});
        } else {
            await client.threadUnarchive({threadId});
        }
        return "done";
    } catch (err) {
        if (isInvalidThreadIdError(err)) return "missing";
        const missingRollout = archived ? isMissingRolloutError(err) : isMissingArchivedRolloutError(err);
        if (!missingRollout) throw err;
        const currentlyArchived = await readThreadArchived(client, threadId, codexHome);
        if (currentlyArchived === "missing") return "missing";
        if (currentlyArchived === archived) {
            logger.log("Thread already in the requested archive state", {threadId, archived});
            return "unchanged";
        }
        throw err;
    }
}

/** Deletes a thread with `thread/delete`. */
export async function deleteThread(client: CodexAppServerClient, threadId: string): Promise<ThreadChangeOutcome> {
    try {
        await client.threadDelete({threadId});
        return "done";
    } catch (err) {
        if (isMissingThreadError(err)) return "missing";
        throw err;
    }
}

/** Whether Codex has the thread archived, from `Thread.path`. `null` when the path is unknown. */
async function readThreadArchived(
    client: CodexAppServerClient,
    threadId: string,
    codexHome: string | null,
): Promise<boolean | "missing" | null> {
    let threadPath: string | null;
    try {
        threadPath = (await client.threadRead({threadId})).thread.path;
    } catch (err) {
        if (isMissingThreadError(err)) return "missing";
        throw err;
    }
    if (threadPath === null) return null;
    return isArchivedRolloutPath(threadPath, codexHome);
}

export function isArchivedRolloutPath(threadPath: string, codexHome: string | null): boolean {
    if (codexHome !== null) {
        const relative = path.relative(path.join(codexHome, ARCHIVED_SESSIONS_DIR), threadPath);
        if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
    }
    return threadPath.replace(/\\/g, "/").split("/").includes(ARCHIVED_SESSIONS_DIR);
}
