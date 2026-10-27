/** Conservative metadata reads over the supported Codex app-server API. */
import {ErrorCodes} from "vscode-jsonrpc/node";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {isConnectionDeathError} from "./app-server-recovery/AppServerRecovery";
import {isAppServerUnavailableError} from "./app-server-recovery/AppServerExit";
import {listedThreadEntry, type SessionIndexThread} from "./SessionIndex";

function rpcError(error: unknown): {code?: unknown; data?: unknown} {
    return error !== null && typeof error === "object" ? error : {};
}

/** Connection and process failures stop the batch. Other read failures omit one row. */
function shouldAbortBatch(error: unknown): boolean {
    const {code, data} = rpcError(error);
    if (isConnectionDeathError(error) || isAppServerUnavailableError(error)
        || code === ErrorCodes.MessageWriteError || code === ErrorCodes.MessageReadError
        || code === ErrorCodes.ConnectionInactive || code === ErrorCodes.ServerNotInitialized) return true;
    return data !== null && typeof data === "object" && "reason" in data && data.reason === "serverShuttingDown";
}

/** Native reads in flight at once. A thread/read of an unknown ID can walk the stored history, so reads run
 *  concurrently; the bound keeps a large batch from flooding the app-server. */
const READ_CONCURRENCY = 8;

/** The metadata of one ID; null for an unreadable or absent record, or one that `session/list` does not show. */
async function readOne(client: CodexAppServerClient, codexHome: string | null, sessionId: string): Promise<SessionIndexThread | null> {
    try {
        const {thread} = await client.threadRead({threadId: sessionId, includeTurns: false});
        // UUID parsing can normalize the ID. Opaque ACP IDs must still match exactly.
        if (thread.id !== sessionId) return null;
        return listedThreadEntry(thread, codexHome);
    } catch (error) {
        if (client.connectionLoss.lost || shouldAbortBatch(error)) throw error;
        return null;
    }
}

export async function readSessionBatchMetadata(
    client: CodexAppServerClient,
    codexHome: string | null,
    sessionIds: string[],
): Promise<SessionIndexThread[]> {
    const entries: SessionIndexThread[] = [];
    for (let start = 0; start < sessionIds.length; start += READ_CONCURRENCY) {
        const chunk = sessionIds.slice(start, start + READ_CONCURRENCY);
        const reads = chunk.map(sessionId => readOne(client, codexHome, sessionId));
        const found = await Promise.all(reads);
        entries.push(...found.filter(entry => entry !== null));
    }
    return entries;
}
