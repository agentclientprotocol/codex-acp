/**
 * Shared explicit title writes for AIR and the native rename tool, coordinated with automatic titles.
 */

import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {ACPSessionConnection} from "./ACPSessionConnection";
import type {SessionIndexHost} from "./SessionIndexService";
import {renameRequestError} from "./SessionIndexMutations";
import {normalizeSessionTitle} from "./SessionTitle";
import type {SessionWriteQueue} from "./SessionWriteQueue";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {SessionState} from "./CodexAcpServer";
import {ErrorCodes, ResponseError} from "vscode-jsonrpc/node";

export interface SessionTitleWriteContext {
    client: CodexAcpClient;
    assertCurrent(): void;
}

export class SessionTitleWriteError extends Error {
    constructor(readonly outcome: "rejected" | "uncertain" | "saved", readonly title: string, override readonly cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
    }
}

/** The title fields that `SessionState` carries for the session index. */
export interface SessionIndexTitleState {
    /**
     * The title that an explicit writer set while the session was loaded here, until its
     * `thread/name/updated` echo. `/rename` clears it.
     */
    sessionIndexExplicitTitle?: string;
    /**
     * The automatic title that the title generation wrote, until its `thread/name/updated` echo. When that
     * echo comes after an explicit rename with another title, it is stale and is not shown.
     */
    automaticTitleEcho?: string;
}

/**
 * Takes a `thread/name/updated` of a loaded session into account, and tells whether it is a late echo of an
 * automatic title that Codex wrote before an explicit rename, which the client must not see.
 */
export function isStaleAutomaticTitleEcho(state: SessionIndexTitleState, name: string | null): boolean {
    const explicitTitle = state.sessionIndexExplicitTitle;
    if (state.automaticTitleEcho !== undefined && name === state.automaticTitleEcho) {
        delete state.automaticTitleEcho;
        if (explicitTitle !== undefined && name !== explicitTitle) return true;
    }
    if (explicitTitle !== undefined && name === explicitTitle) {
        // The echo of the rename: an automatic title echo can no longer follow.
        delete state.sessionIndexExplicitTitle;
        delete state.automaticTitleEcho;
    }
    return false;
}

export class SessionIndexTitles {
    /**
     * The sessions with an explicit title write, by session id. It outlives the
     * `SessionState`, so an automatic title of a session that was closed or loaded again since its generation
     * started still sees the rename, see {@link writeAutomaticTitle}.
     */
    private readonly explicitTitles = new Map<string, {
        protected: boolean;
        pending: number;
        previousSource: SessionState["sessionTitleSource"] | undefined;
    }>();

    constructor(private readonly host: SessionIndexHost, private readonly writes: SessionWriteQueue) {}

    /**
     * Sets an explicit title. A tool call also fences the originating session and app-server.
     *
     * The rename is recorded before its write waits for its turn in the write queue, so an automatic title
     * that has not been written yet is skipped, and one that Codex is writing now completes before this write
     * starts. An uncertain write stays protected because it may have succeeded.
     */
    async rename(sessionId: string, requestedTitle: string, context?: SessionTitleWriteContext): Promise<string> {
        const title = normalizeSessionTitle(requestedTitle);
        if (title === null) {
            throw RequestError.invalidParams({sessionId}, "title must be a non-empty string");
        }
        const sessionState = this.host.session(sessionId);
        const previousTitleSource = sessionState?.sessionTitleSource;
        if (sessionState) {
            sessionState.sessionTitleSource = "explicit";
        }
        const explicitTitle = this.explicitTitles.get(sessionId) ?? {protected: false, pending: 0, previousSource: previousTitleSource};
        this.explicitTitles.set(sessionId, explicitTitle);
        explicitTitle.pending++;
        let outcome: "rejected" | "uncertain" = "rejected";
        try {
            await this.writes.run(sessionId, async () => {
                // The outcome is recorded before the next title write of the queue starts, so an automatic
                // title that waits behind this rename sees whether it failed.
                try {
                    context?.assertCurrent();
                    const client = context?.client ?? this.host.client();
                    outcome = "uncertain";
                    try {
                        await this.host.runWithProcessCheck(() => client.renameSession(sessionId, title));
                    } catch (err) {
                        if (err instanceof ResponseError && !client.appServerClient.connectionLoss.lost
                            && err.code !== ErrorCodes.PendingResponseRejected
                            && err.code !== ErrorCodes.ConnectionInactive
                            && err.code !== ErrorCodes.MessageWriteError && err.code !== ErrorCodes.MessageReadError) {
                            outcome = "rejected";
                        }
                        throw err;
                    }
                } catch (err) {
                    explicitTitle.pending--;
                    if (outcome === "uncertain") explicitTitle.protected = true;
                    if (!explicitTitle.protected && explicitTitle.pending === 0
                        && this.explicitTitles.get(sessionId) === explicitTitle) {
                        this.explicitTitles.delete(sessionId);
                    }
                    if (!this.explicitTitles.has(sessionId) && sessionState && explicitTitle.previousSource !== undefined
                        && sessionState.sessionTitleSource === "explicit") {
                        sessionState.sessionTitleSource = explicitTitle.previousSource;
                    }
                    if (!this.explicitTitles.has(sessionId)) {
                        // An automatic title that was dropped for this rename comes after the next turn.
                        sessionState?.titleGen?.retryAfterFailedRename();
                        this.host.session(sessionId)?.titleGen?.retryAfterFailedRename();
                    }
                    throw err;
                }
                explicitTitle.pending--;
                explicitTitle.protected = true;
            });
        } catch (err) {
            const client = context?.client ?? this.host.client();
            const cause = await renameRequestError(client.appServerClient, sessionId, err, client.getHomePath());
            throw new SessionTitleWriteError(outcome, title, cause);
        }
        try {
            context?.assertCurrent();
        } catch (err) {
            throw new SessionTitleWriteError("saved", title, err);
        }
        sessionState?.titleGen?.markExistingTitle();
        const current = this.host.session(sessionId);
        if (current) {
            current.titleGen?.markExistingTitle();
            current.sessionTitle = title;
            current.sessionTitleSource = "explicit";
            current.sessionIndexExplicitTitle = title;
            // Sent here, not left to the `thread/name/updated` echo: a session gets the Codex notifications
            // of its thread only after its first prompt on this connection.
            try {
                await new ACPSessionConnection(this.host.connection(), sessionId).update({
                    sessionUpdate: "session_info_update",
                    title,
                });
            } catch (err) {
                throw new SessionTitleWriteError("saved", title, err);
            }
        }
        return title;
    }

    /**
     * Writes an automatic title unless an explicit write has set or might have set it.
     * The check runs when the write gets its turn, even if its session was loaded again.
     */
    writeAutomaticTitle(sessionId: string, title: string, write: () => Promise<boolean>): Promise<boolean> {
        return this.writes.run(sessionId, async () => {
            if (this.explicitTitles.has(sessionId)) return false;
            // Its echo can come after a later explicit rename, see `isStaleAutomaticTitleEcho`.
            const echo = normalizeSessionTitle(title) ?? undefined;
            const current = this.host.session(sessionId);
            if (current && echo !== undefined) current.automaticTitleEcho = echo;
            let written = false;
            try {
                written = await write();
                return written;
            } finally {
                if (!written && current?.automaticTitleEcho === echo) delete current?.automaticTitleEcho;
            }
        });
    }

    /** The thread is deleted. */
    forget(sessionId: string): void {
        this.explicitTitles.delete(sessionId);
    }
}
