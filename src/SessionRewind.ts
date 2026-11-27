import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread} from "./app-server/v2";
import {logger} from "./Logger";
import type {CursorTurn} from "./SessionCursors";

/**
 * `_session/rewind` (AIR to agent): removes a user message and everything after it from the context
 * of the same session. The position is a session cursor, see `SessionCursors.ts`: the one before the
 * user message to drop. Codex cuts whole turns with `thread/revert`, which persists the cut.
 *
 * `rewound: true` means that the cut is live and persisted. `rewound: false` means that nothing
 * changed. Every `thread/revert` call, even a failing one, reloads the thread: that interrupts a
 * running turn and kills the background terminals. So the refusals are decided before the call.
 */
export const SESSION_REWIND_METHOD = "_session/rewind";

export type SessionRewindRequest = {
    sessionId: string;
    cursorId: string;
};

export type SessionRewindReason = "busy" | "backgroundWork" | "providerRefused";

export type SessionRewindResponse =
    | {rewound: true}
    | {rewound: false; reason: SessionRewindReason};

/** Only a thread with paginated history can be reverted. */
export function isRewindableThread(thread: Pick<Thread, "ephemeral" | "historyMode">): boolean {
    return !thread.ephemeral && thread.historyMode === "paginated";
}

export type SessionRewindDependencies = {
    codexClient: Pick<CodexAppServerClient, "threadRevert" | "threadTurnPages" | "backgroundTerminalPages">;
    threadId: string;
    /** See {@link isRewindableThread}. */
    rewindable: boolean;
    /** Codex runs a turn, also one that it started on its own. */
    isCodexTurnRunning(): boolean;
    /** A native subagent runs. */
    hasRunningSubagents(): boolean;
    resolveCursorTurn(cursorId: string): Promise<CursorTurn>;
    /** Throws when the session is closed or replaced: nothing may be reverted for it. Called with no await before `thread/revert`. */
    assertSessionHeld(): void;
    /** The cut is done: the session state follows the cut. The notifications of the reload are drained after it, by the caller. */
    rewound(cursorId: string): Promise<void>;
};

/**
 * Runs the rewind of a session that is loaded, idle as far as the adapter knows, and holds the turn-start
 * slot, so that no prompt starts meanwhile. Throws invalid params for a cursor that the session never
 * announced with `rewind`.
 */
export async function rewindSession(
    request: SessionRewindRequest,
    dependencies: SessionRewindDependencies,
): Promise<SessionRewindResponse> {
    const {codexClient, threadId} = dependencies;
    // Codex starts turns on its own, such as a goal continuation. The caller checked its own work before it awaited.
    if (dependencies.isCodexTurnRunning()) return {rewound: false, reason: "busy"};
    if (!dependencies.rewindable) {
        throw RequestError.invalidParams({cursorId: request.cursorId}, `Session ${request.sessionId} cannot be rewound: Codex keeps its history in a form that thread/revert does not take. Use a cursor with the rewind capability`);
    }
    if (dependencies.hasRunningSubagents() || await hasBackgroundTerminals(codexClient, threadId)) {
        return {rewound: false, reason: "backgroundWork"};
    }
    const {turnId} = await dependencies.resolveCursorTurn(request.cursorId);
    // A turn can start during the awaits above. Nothing may await between this check and the call.
    if (dependencies.isCodexTurnRunning()) return {rewound: false, reason: "busy"};
    if (dependencies.hasRunningSubagents()) return {rewound: false, reason: "backgroundWork"};
    dependencies.assertSessionHeld();
    try {
        await codexClient.threadRevert({threadId, beforeTurnId: turnId});
    } catch (error) {
        // Some errors arrive after the cut, so the thread tells whether it happened.
        if (await isTurnListed(codexClient, threadId, turnId, error)) {
            logger.error(`thread/revert of session ${request.sessionId} was refused`, error);
            return {rewound: false, reason: "providerRefused"};
        }
        logger.error(`thread/revert of session ${request.sessionId} failed after the cut`, error);
    }
    await dependencies.rewound(request.cursorId);
    return {rewound: true};
}

async function hasBackgroundTerminals(codexClient: SessionRewindDependencies["codexClient"], threadId: string): Promise<boolean> {
    for await (const page of codexClient.backgroundTerminalPages(threadId)) {
        if (page.length > 0) return true;
    }
    return false;
}

/** Whether the turn is still in the thread. When the thread cannot be read, the revert error is the answer. */
async function isTurnListed(
    codexClient: SessionRewindDependencies["codexClient"],
    threadId: string,
    turnId: string,
    revertError: unknown,
): Promise<boolean> {
    try {
        for await (const page of codexClient.threadTurnPages({threadId, limit: 100, sortDirection: "asc", itemsView: "notLoaded"})) {
            if (page.some(turn => turn.id === turnId)) return true;
        }
        return false;
    } catch (listError) {
        logger.error(`Could not read the turns of session ${threadId} after a failed thread/revert`, listError);
        throw revertError;
    }
}
