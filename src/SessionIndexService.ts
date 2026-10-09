/**
 * The AIR `sessionIndex` extension as `CodexAcpServer` serves it: the session list, `_session/rename`,
 * `_session/archive`, `_session/unarchive`, `session/delete` and `_session/list/subscribe`. Nothing here runs
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
import {sessionNotFoundRequestError} from "./CodexThreadErrors";
import {logger} from "./Logger";
import {arePathBasenamesEqual, isAbsolutePathLike} from "./PathUtils";
import type {Thread} from "./app-server/v2";
import {
    AIR_ARCHIVED_KEY,
    AIR_SESSION_ARCHIVE_KEY,
    AIR_SESSION_INDEX_KEY,
    AIR_SESSION_LIST_SUBSCRIBE_KEY,
    AIR_SESSION_RENAME_KEY,
    readSessionIndexListOptions,
    readSessionIndexPage,
    SESSION_ARCHIVE_METHOD,
    SESSION_LIST_CHANGES_METHOD,
    SESSION_LIST_SUBSCRIBE_METHOD,
    SESSION_LIST_UNSUBSCRIBE_METHOD,
    SESSION_RENAME_METHOD,
    SESSION_UNARCHIVE_METHOD,
    SessionIndexActivity,
    sessionIndexSessionInfo,
    type SessionArchiveRequest,
    type SessionIndexListOptions,
    type SessionRenameRequest,
} from "./SessionIndex";
import {deleteThread, sessionIndexRequestError, setThreadArchived} from "./SessionIndexMutations";
import {SessionIndexTitles} from "./SessionIndexTitles";
import {canonicalCwds, linkedWorktreeCwds} from "./SessionIndexWorktrees";
import {SessionForkOrigins} from "./SessionForkOrigins";
import {SessionListSubscriptions, type SessionListSubscriptionTimings, type ThreadEntry} from "./SessionListSubscriptions";
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
    /** Closes a session open here as `session/close` does: ends its turn, its pending prompt and interactions. */
    closeSession(sessionId: string): Promise<void>;
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
    private readonly subscriptions: SessionListSubscriptions;
    private readonly forkOrigins: SessionForkOrigins;
    /** The app-server clients whose notifications reach the session index, each once. */
    private readonly observedClients = new WeakSet<CodexAcpClient>();
    private anyClientObserved = false;
    /** The threads whose last row had a state, as listed or sent: loaded here. */
    private readonly rowsWithState = new Set<string>();

    constructor(private readonly host: SessionIndexHost, subscriptionTimings?: SessionListSubscriptionTimings) {
        this.activity = new SessionIndexActivity(threadId => host.session(threadId) !== undefined);
        this.titles = new SessionIndexTitles(host, this.writes);
        // `thread/list` gives no fork parent: a row gets it once the rollout is read, a subscription with a change.
        this.forkOrigins = new SessionForkOrigins({onFound: (threadIds) => this.subscriptions.threadsChanged(threadIds)});
        this.subscriptions = new SessionListSubscriptions({
            reader: () => {
                const appServer = host.client().appServerClient;
                return appServer.connectionLoss.lost ? null : appServer;
            },
            codexHome: () => host.client().getHomePath(),
            rows: async (entries) => await this.rows(entries),
            // The canonical path too outside a Git checkout, where linkedWorktreeCwds gives the cwd alone.
            scopeCwds: (cwd) => [...new Set([...canonicalCwds(cwd), ...linkedWorktreeCwds(cwd)])],
            notify: async (changes) => {
                await host.connection().notify(SESSION_LIST_CHANGES_METHOD, changes);
            },
            ...(subscriptionTimings ? {timings: subscriptionTimings} : {}),
        });
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
        return this.enabled
            ? [AIR_SESSION_INDEX_KEY, AIR_SESSION_ARCHIVE_KEY, AIR_SESSION_RENAME_KEY, AIR_SESSION_LIST_SUBSCRIBE_KEY]
            : [];
    }

    /**
     * Feeds the thread notifications of an app-server, for every thread, to the session index. Each client is
     * observed once, and only the client that runs now counts: a crashed one that still reports is ignored.
     */
    observe(client: CodexAcpClient): void {
        if (!this.enabled || this.observedClients.has(client)) return;
        // Another app-server: one that crashed sent no end of its turns or reviews.
        if (this.anyClientObserved) {
            this.subscriptions.refreshLoadedThreads([...this.activity.resetLoaded(), ...this.rowsWithState]);
            this.rowsWithState.clear();
        }
        this.anyClientObserved = true;
        this.observedClients.add(client);
        client.appServerClient.onClientTransportEvent((event) => {
            if (event.eventType !== "notification" || this.host.client() !== client) return;
            const notification = event as unknown as ServerNotification;
            this.activity.observe(notification);
            // A thread deleted or unloaded here has no state to refresh after a restart.
            if (notification.method === "thread/deleted" || notification.method === "thread/closed"
                || (notification.method === "thread/status/changed" && notification.params.status.type === "notLoaded")) {
                this.rowsWithState.delete(notification.params.threadId);
            }
            this.subscriptions.observe(notification);
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
        return await this.readRows(cwd, options, params.cursor ?? null);
    }

    /**
     * `_session/list/subscribe {cwd}`: answers `{subscriptionId}` and then sends `_session/list/changes` for the
     * threads of the cwd and its worktrees, see `SessionListSubscriptions`.
     *
     * @throws RequestError `invalidParams` for a `cwd` that is missing, not a string or not absolute, and with
     *   `data.reason: "too_many_subscriptions"` beyond the limit of the connection.
     */
    async subscribeList(params: Record<string, unknown>): Promise<{subscriptionId: string}> {
        this.require(SESSION_LIST_SUBSCRIBE_METHOD);
        const cwd = params["cwd"];
        if (typeof cwd !== "string" || !isAbsolutePathLike(cwd)) {
            throw RequestError.invalidParams({cwd: cwd ?? null}, "cwd must be an absolute path");
        }
        await this.host.ensureAppServer();
        return {subscriptionId: await this.subscriptions.subscribe(cwd)};
    }

    /** `_session/list/unsubscribe {subscriptionId}`: idempotent. */
    unsubscribeList(params: Record<string, unknown>): Record<string, never> {
        this.require(SESSION_LIST_UNSUBSCRIBE_METHOD);
        const subscriptionId = params["subscriptionId"];
        if (typeof subscriptionId !== "string") {
            throw RequestError.invalidParams({subscriptionId: subscriptionId ?? null}, "subscriptionId must be a string");
        }
        this.subscriptions.unsubscribe(subscriptionId);
        return {};
    }

    /** The subscriptions of the connection, for tests. */
    subscriptionResources(): ReturnType<SessionListSubscriptions["resources"]> {
        return this.subscriptions.resources();
    }

    /** `_session/rename`. */
    async rename({sessionId, title}: SessionRenameRequest): Promise<Record<string, never>> {
        this.require(SESSION_RENAME_METHOD);
        await this.host.ensureAppServer();
        await this.titles.rename(sessionId, title);
        return {};
    }

    /**
     * `_session/archive` and `_session/unarchive`, as `session/archive` and `session/unarchive` of ACP RFD #2161.
     * Both are idempotent and work for a session that is not loaded. Archiving stops a session that is open here,
     * as `thread/archive` unloads a loaded thread: it is closed as `session/close` closes it, then archived.
     * Unarchiving loads nothing: the client loads the session again to work in it.
     */
    async setArchived({sessionId}: SessionArchiveRequest, archived: boolean): Promise<Record<string, never>> {
        this.require(archived ? SESSION_ARCHIVE_METHOD : SESSION_UNARCHIVE_METHOD);
        logger.log(archived ? "Archiving session..." : "Unarchiving session...", {sessionId});
        await this.host.ensureAppServer();
        // Read before the fence, which counts as open.
        const open = this.host.hasLocalSession(sessionId);
        // An open of the session that starts meanwhile would load the thread that Codex archives.
        if (archived) this.host.beginSessionCloseFence(sessionId);
        try {
            // Outside the write queue: the turn that the close ends may still write its title.
            if (archived && open) await this.host.closeSession(sessionId);
            await this.writes.run(sessionId, async () => {
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
            });
        } finally {
            if (archived) this.host.endSessionCloseFence(sessionId);
        }
        // An archived session was closed above: the update still goes to its client, to tell it why.
        if (archived ? open : this.host.session(sessionId) !== undefined) {
            await new ACPSessionConnection(this.host.connection(), sessionId).update({
                sessionUpdate: "session_info_update",
                _meta: withAirMeta(undefined, AIR_ARCHIVED_KEY, archived),
            });
        }
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
            this.rowsWithState.delete(sessionId);
        });
    }

    /** Ends the session list subscriptions. The connection is gone. */
    dispose(): void {
        this.subscriptions.dispose();
        this.forkOrigins.dispose();
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
        return {sessions: await this.rows(page.threads), nextCursor: page.nextCursor};
    }

    /**
     * The list rows of threads, for `session/list` and `_session/list/changes` alike. A row has the fork parent
     * known for its thread; one that is not read yet is read in the background, see `SessionForkOrigins`.
     */
    private async rows(entries: ThreadEntry[]): Promise<acp.SessionInfo[]> {
        return entries.map(entry => {
            const forkedFromId = this.forkOrigins.originOf(entry.thread);
            const thread = forkedFromId === entry.thread.forkedFromId ? entry.thread : {...entry.thread, forkedFromId};
            const activity = this.activity.activityOf(thread);
            // A row with a state is of a thread loaded here: a restart of the app-server changes it.
            if (activity?.state !== undefined) this.rowsWithState.add(thread.id);
            else this.rowsWithState.delete(thread.id);
            return this.withActiveAdditionalDirectories(
                sessionIndexSessionInfo(thread, entry.archived, activity),
            );
        });
    }

    private withActiveAdditionalDirectories(session: acp.SessionInfo): acp.SessionInfo {
        const activeSession = this.host.session(session.sessionId);
        if (!activeSession || activeSession.additionalDirectories.length === 0) {
            return session;
        }
        return {...session, additionalDirectories: activeSession.additionalDirectories};
    }
}
