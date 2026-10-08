/**
 * The AIR `sessionIndex` extension as `CodexAcpServer` serves it: the session list, `_session/rename`,
 * `_session/archive`, `_session/unarchive`, `session/delete` and `_session/list_changed`. Nothing here runs
 * for a client that does not declare `sessionIndex`. See `SessionIndex.ts` and `docs/air-extensions.md`.
 */

import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type AcpClientConnection} from "./ACPSessionConnection";
import {clientSupportsAirCapability, withAirMeta} from "./AirExtension";
import type {ServerNotification} from "./app-server";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {SessionState} from "./CodexAcpServer";
import {sessionActiveRequestError, sessionNotFoundRequestError} from "./CodexThreadErrors";
import {logger} from "./Logger";
import {arePathBasenamesEqual, isAbsolutePathLike} from "./PathUtils";
import {
    AIR_ARCHIVED_KEY,
    AIR_SESSION_ARCHIVE_KEY,
    AIR_SESSION_INDEX_KEY,
    AIR_SESSION_RENAME_KEY,
    changesSessionIndex,
    readSessionIndexListOptions,
    readSessionIndexPage,
    SESSION_ARCHIVE_METHOD,
    SESSION_LIST_CHANGED_METHOD,
    SESSION_RENAME_METHOD,
    SESSION_UNARCHIVE_METHOD,
    SessionIndexActivity,
    sessionIndexPageSignature,
    sessionIndexSessionInfo,
    type SessionArchiveRequest,
    type SessionIndexListOptions,
    type SessionRenameRequest,
} from "./SessionIndex";
import {deleteThread, sessionIndexRequestError, setThreadArchived} from "./SessionIndexMutations";
import {SessionIndexTitles} from "./SessionIndexTitles";
import {canonicalCwds, linkedWorktreeCwds} from "./SessionIndexWorktrees";
import {SessionListChangedWatcher} from "./SessionListChangedWatcher";
import {SessionWriteQueue} from "./SessionWriteQueue";
import type {SerializeTitleWrite} from "./TitleGenerator";

/** What the session index needs from `CodexAcpServer`. */
export interface SessionIndexHost {
    connection(): AcpClientConnection;
    client(): CodexAcpClient;
    /** Starts the app-server again when it crashed; resolves when one runs. */
    ensureAppServer(): Promise<void>;
    runWithProcessCheck<T>(operation: () => Promise<T>): Promise<T>;
    session(sessionId: string): SessionState | undefined;
    hasLocalSession(sessionId: string): boolean;
    beginSessionCloseFence(sessionId: string): void;
    endSessionCloseFence(sessionId: string): void;
}

type SessionPage = {sessions: acp.SessionInfo[], nextCursor: string | null};

export class SessionIndexService {
    /** The client declared the AIR `sessionIndex` capability. */
    enabled = false;
    private readonly activity: SessionIndexActivity;
    private readonly writes = new SessionWriteQueue();
    private readonly titles: SessionIndexTitles;
    /** Created on the first `session/list` of page 1 for an absolute cwd. */
    private watcher: SessionListChangedWatcher | null = null;
    /** The connection is gone, see {@link dispose}. */
    private disposed = false;

    constructor(private readonly host: SessionIndexHost) {
        this.activity = new SessionIndexActivity(threadId => host.session(threadId) !== undefined);
        this.titles = new SessionIndexTitles(host, this.writes);
    }

    /** Reads the client capabilities of `initialize`. */
    configure(clientCapabilities: acp.ClientCapabilities | undefined): void {
        this.enabled = clientSupportsAirCapability(clientCapabilities, AIR_SESSION_INDEX_KEY);
    }

    /**
     * The AIR capabilities to answer: only a client that declares `sessionIndex` gets them. `sessionArchive` and
     * `sessionRename` name the requests that come with it; the client need not declare them.
     */
    agentCapabilities(): string[] {
        return this.enabled ? [AIR_SESSION_INDEX_KEY, AIR_SESSION_ARCHIVE_KEY, AIR_SESSION_RENAME_KEY] : [];
    }

    /** Feeds the thread notifications of an app-server, for every thread, to the session index. */
    observe(client: CodexAcpClient): void {
        if (!this.enabled) return;
        client.appServerClient.onClientTransportEvent((event) => {
            if (event.eventType !== "notification") return;
            const notification = event as unknown as ServerNotification;
            this.activity.observe(notification);
            if (changesSessionIndex(notification)) {
                this.watcher?.trigger();
            }
        });
    }

    /** The title write of `TitleGenerator` for a session, see {@link SessionIndexTitles.writeAutomaticTitle}. */
    titleWriter(sessionId: string): SerializeTitleWrite {
        return (title, write) => this.titles.writeAutomaticTitle(sessionId, title, write);
    }

    /**
     * Answers `session/list`. Codex filters by the cwd and its worktrees, sorts by recency and limits the
     * page. Only a relative cwd is filtered after the read. The list does not check the login: `thread/list`
     * reads the local state DB and works without one.
     */
    async list(params: acp.ListSessionsRequest): Promise<SessionPage> {
        const options = readSessionIndexListOptions(params._meta);
        const cwd = params.cwd?.trim() || null;
        const page = await this.readRows(cwd, options, params.cursor ?? null);
        // A relative cwd is filtered by the adapter, page by page, which is too costly to repeat on every change.
        if (cwd !== null && !params.cursor && isAbsolutePathLike(cwd)) {
            this.watch(cwd, options, sessionIndexPageSignature(page.sessions, page.nextCursor));
        }
        return page;
    }

    /** `_session/rename`. */
    async rename({sessionId, title}: SessionRenameRequest): Promise<Record<string, never>> {
        this.require(SESSION_RENAME_METHOD);
        await this.host.ensureAppServer();
        await this.titles.rename(sessionId, title);
        this.watcher?.trigger();
        return {};
    }

    /**
     * `_session/archive` and `_session/unarchive`, as `session/archive` and `session/unarchive` of ACP RFD #2161.
     * Both are idempotent and work for a session that is not loaded. Neither loads, resumes, closes or cancels
     * a session: `thread/archive` would unload a thread that this process has loaded, so archiving a session
     * that is open here fails with the `session_active` reason and changes nothing. The client closes it first.
     * Unarchiving needs no such rule: Codex does not load an archived thread, so an open one is unarchived.
     */
    async setArchived({sessionId}: SessionArchiveRequest, archived: boolean): Promise<Record<string, never>> {
        this.require(archived ? SESSION_ARCHIVE_METHOD : SESSION_UNARCHIVE_METHOD);
        logger.log(archived ? "Archiving session..." : "Unarchiving session...", {sessionId});
        await this.host.ensureAppServer();
        await this.writes.run(sessionId, async () => {
            if (archived && this.host.hasLocalSession(sessionId)) {
                throw sessionActiveRequestError(sessionId);
            }
            // An open of the session that starts meanwhile would load the thread that Codex archives.
            if (archived) this.host.beginSessionCloseFence(sessionId);
            try {
                let outcome;
                try {
                    const client = this.host.client();
                    outcome = await this.host.runWithProcessCheck(
                        () => setThreadArchived(client.appServerClient, sessionId, archived, client.getHomePath()),
                    );
                } catch (err) {
                    throw sessionIndexRequestError(sessionId, err);
                }
                if (outcome === "missing") {
                    throw sessionNotFoundRequestError(sessionId);
                }
            } finally {
                if (archived) this.host.endSessionCloseFence(sessionId);
            }
        });
        if (this.host.session(sessionId)) {
            await new ACPSessionConnection(this.host.connection(), sessionId).update({
                sessionUpdate: "session_info_update",
                _meta: withAirMeta(undefined, AIR_ARCHIVED_KEY, archived),
            });
        }
        this.watcher?.trigger();
        return {};
    }

    /**
     * Deletes the thread for `session/delete`: AIR then means "delete", not "done", because it has
     * `_session/archive` for that. A thread that this connection had open but Codex never persisted (no
     * prompt yet) is gone with the close, so it counts as deleted.
     */
    async deleteThread(sessionId: string, hadLocalSession: boolean): Promise<void> {
        await this.writes.run(sessionId, async () => {
            let outcome;
            try {
                outcome = await this.host.runWithProcessCheck(
                    () => deleteThread(this.host.client().appServerClient, sessionId),
                );
            } catch (err) {
                throw sessionIndexRequestError(sessionId, err);
            }
            if (outcome === "missing" && !hadLocalSession) {
                throw sessionNotFoundRequestError(sessionId);
            }
            this.activity.forget(sessionId);
            this.titles.forget(sessionId);
            this.watcher?.trigger();
        });
    }

    /** Stops the session list watcher. The connection is gone. */
    dispose(): void {
        this.disposed = true;
        this.watcher?.dispose();
        this.watcher = null;
    }

    private require(method: string): void {
        if (!this.enabled) {
            throw RequestError.methodNotFound(method);
        }
    }

    private async readRows(cwd: string | null, options: SessionIndexListOptions, cursor: string | null): Promise<SessionPage> {
        // Codex filters by an absolute cwd. A relative one keeps the basename filter of the old path, which the
        // adapter applies to each page of the unfiltered list.
        const relativeCwd = cwd !== null && !isAbsolutePathLike(cwd) ? cwd : null;
        const cwds = cwd === null || relativeCwd !== null
            ? null
            : options.includeWorktrees ? linkedWorktreeCwds(cwd) : canonicalCwds(cwd);
        const page = await this.host.runWithProcessCheck(() => readSessionIndexPage(
            (listParams) => this.host.client().appServerClient.threadList(listParams),
            cwds,
            options,
            cursor,
            relativeCwd === null ? undefined : (thread) => arePathBasenamesEqual(thread.cwd, relativeCwd),
            cwd === null || relativeCwd !== null ? cwd : path.resolve(cwd),
        ));
        return {
            sessions: page.threads.map(entry => this.withActiveAdditionalDirectories(
                sessionIndexSessionInfo(entry.thread, entry.archived, this.activity.activityOf(entry.thread)),
            )),
            nextCursor: page.nextCursor,
        };
    }

    private withActiveAdditionalDirectories(session: acp.SessionInfo): acp.SessionInfo {
        const activeSession = this.host.session(session.sessionId);
        if (!activeSession || activeSession.additionalDirectories.length === 0) {
            return session;
        }
        return {...session, additionalDirectories: activeSession.additionalDirectories};
    }

    private watch(cwd: string, options: SessionIndexListOptions, signature: string): void {
        // A list that was in flight when the connection closed must not start the watcher again.
        if (this.disposed) return;
        this.watcher ??= new SessionListChangedWatcher({
            codexHome: () => this.host.client().getHomePath(),
            readSignature: async (watched) => {
                const page = await this.readRows(watched.cwd, watched.options, null);
                return sessionIndexPageSignature(page.sessions, page.nextCursor);
            },
            notify: async (changedCwd) => {
                await this.host.connection().notify(SESSION_LIST_CHANGED_METHOD, {cwd: changedCwd});
            },
        });
        this.watcher.observeList({cwd, options}, signature);
    }
}
