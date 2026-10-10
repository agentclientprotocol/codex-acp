/**
 * The titles of the AIR `sessionIndex` extension: `_session/rename`, and how it and the automatic title of
 * `TitleGenerator` keep out of each other's way. See `docs/air-extensions.md`.
 */

import {RequestError} from "@agentclientprotocol/sdk";
import {ACPSessionConnection} from "./ACPSessionConnection";
import type {SessionIndexHost} from "./SessionIndexService";
import {renameRequestError} from "./SessionIndexMutations";
import {normalizeSessionTitle} from "./SessionTitle";
import type {SessionWriteQueue} from "./SessionWriteQueue";

/** The title fields that `SessionState` carries for the session index. */
export interface SessionIndexTitleState {
    /**
     * The title that `_session/rename` set while the session was loaded here, until its
     * `thread/name/updated` echo. `/rename` clears it.
     */
    sessionIndexExplicitTitle?: string;
    /**
     * The automatic title that the title generation wrote, until its `thread/name/updated` echo. When that
     * echo comes after a `_session/rename` with another title, it is stale and is not shown.
     */
    automaticTitleEcho?: string;
}

/**
 * Takes a `thread/name/updated` of a loaded session into account, and tells whether it is a late echo of an
 * automatic title that Codex wrote before `_session/rename`, which the client must not see.
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
     * The sessions whose title `_session/rename` has set or is setting, by session id. It outlives the
     * `SessionState`, so an automatic title of a session that was closed or loaded again since its generation
     * started still sees the rename, see {@link writeAutomaticTitle}.
     */
    private readonly explicitTitles = new Map<string, {confirmed: boolean, pending: number}>();

    constructor(private readonly host: SessionIndexHost, private readonly writes: SessionWriteQueue) {}

    /**
     * `_session/rename`: sets the explicit title of a thread, loaded or not.
     *
     * The rename is recorded before its write waits for its turn in the write queue, so an automatic title
     * that has not been written yet is skipped, and one that Codex is writing now completes before this write
     * starts. Automatic titles stop for good only once the rename succeeded.
     */
    async rename(sessionId: string, requestedTitle: string): Promise<void> {
        const title = normalizeSessionTitle(requestedTitle);
        if (title === null) {
            throw RequestError.invalidParams({sessionId}, "title must be a non-empty string");
        }
        const sessionState = this.host.session(sessionId);
        const previousTitleSource = sessionState?.sessionTitleSource;
        if (sessionState) {
            sessionState.sessionTitleSource = "explicit";
        }
        const explicitTitle = this.explicitTitles.get(sessionId) ?? {confirmed: false, pending: 0};
        this.explicitTitles.set(sessionId, explicitTitle);
        explicitTitle.pending++;
        try {
            await this.writes.run(sessionId, async () => {
                // The outcome is recorded before the next title write of the queue starts, so an automatic
                // title that waits behind this rename sees whether it failed.
                try {
                    await this.host.runWithProcessCheck(() => this.host.client().renameSession(sessionId, title));
                } catch (err) {
                    explicitTitle.pending--;
                    if (!explicitTitle.confirmed && explicitTitle.pending === 0
                        && this.explicitTitles.get(sessionId) === explicitTitle) {
                        this.explicitTitles.delete(sessionId);
                    }
                    if (sessionState && previousTitleSource !== undefined
                        && sessionState.sessionTitleSource === "explicit") {
                        sessionState.sessionTitleSource = previousTitleSource;
                    }
                    if (!this.explicitTitles.has(sessionId)) {
                        // An automatic title that was dropped for this rename comes after the next turn.
                        sessionState?.titleGen?.retryAfterFailedRename();
                        this.host.session(sessionId)?.titleGen?.retryAfterFailedRename();
                    }
                    throw err;
                }
                explicitTitle.pending--;
                explicitTitle.confirmed = true;
            });
        } catch (err) {
            const client = this.host.client();
            throw await renameRequestError(client.appServerClient, sessionId, err, client.getHomePath());
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
            await new ACPSessionConnection(this.host.connection(), sessionId).update({
                sessionUpdate: "session_info_update",
                title,
            });
        }
    }

    /**
     * Writes an automatic title in the write queue of the session, unless `_session/rename` has set or is
     * setting the title. The check runs when the write gets its turn, whatever `SessionState` the generator
     * belongs to. Only a `sessionIndex` client renames this way, so nothing changes for other clients.
     */
    writeAutomaticTitle(sessionId: string, title: string, write: () => Promise<boolean>): Promise<boolean> {
        return this.writes.run(sessionId, async () => {
            if (this.explicitTitles.has(sessionId)) return false;
            // Its echo can come after a later `_session/rename`, see `isStaleAutomaticTitleEcho`.
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
