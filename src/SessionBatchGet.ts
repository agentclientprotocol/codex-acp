/** Conservative metadata reads over the supported Codex app-server API. */
import {ErrorCodes} from "vscode-jsonrpc/node";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {isConnectionDeathError} from "./app-server-recovery/AppServerRecovery";
import {isAppServerUnavailableError} from "./app-server-recovery/AppServerExit";
import {isArchivedRolloutPath} from "./SessionIndexMutations";
import type {SessionIndexThread} from "./SessionIndex";

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

export async function readSessionBatchMetadata(
    client: CodexAppServerClient,
    codexHome: string | null,
    sessionIds: string[],
): Promise<SessionIndexThread[]> {
    const entries: SessionIndexThread[] = [];
    for (const sessionId of sessionIds) {
        try {
            const {thread} = await client.threadRead({threadId: sessionId, includeTurns: false});
            // UUID parsing can normalize the ID. Opaque ACP IDs must still match exactly.
            if (thread.id !== sessionId) continue;
            entries.push({thread, archived: thread.path !== null && isArchivedRolloutPath(thread.path, codexHome)});
        } catch (error) {
            if (client.connectionLoss.lost || shouldAbortBatch(error)) throw error;
            // Unreadable or absent records contribute no row.
        }
    }
    return entries;
}
