/**
 * The AIR `sessionIndex` extension: the session list that AIR uses as its
 * index of Codex threads, and the requests that change an entry of it.
 *
 * Everything here applies only to a client that declares `sessionIndex` in
 * `clientCapabilities._meta.jetbrains.air.capabilities`. Other clients keep
 * the `session/list` path of {@link CodexAcpClient.listSessions}.
 * See `docs/air-extensions.md`.
 */

import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {ServerNotification} from "./app-server";
import type {Thread, ThreadListParams, ThreadListResponse, ThreadStatus} from "./app-server/v2";
import {AIR_META_KEY, JETBRAINS_META_KEY, withAirMeta} from "./AirExtension";
import {normalizeSessionTitle} from "./SessionTitle";
import {logger} from "./Logger";

export const AIR_SESSION_INDEX_KEY = "sessionIndex";
export const SESSION_RENAME_METHOD = "_session/rename";
export const SESSION_ARCHIVE_METHOD = "_session/archive";
export const SESSION_UNARCHIVE_METHOD = "_session/unarchive";
export const SESSION_LIST_CHANGED_METHOD = "_session/list_changed";

/** The `_meta.jetbrains.air` key of the list options in a `session/list` request. */
export const AIR_SESSION_LIST_KEY = "list";
export const AIR_GIT_BRANCH_KEY = "gitBranch";
export const AIR_ACTIVITY_KEY = "activity";

export const DEFAULT_SESSION_INDEX_LIMIT = 50;
/** The largest page that the adapter asks Codex for. */
export const MAX_SESSION_INDEX_LIMIT = 100;

export type SessionIndexArchivedFilter = "exclude" | "only";

export interface SessionIndexListOptions {
    limit: number;
    archived: SessionIndexArchivedFilter;
}

export type SessionActivityState = "running" | "idle" | "requires_action";

export interface SessionActivity {
    state?: SessionActivityState;
    lastTurnEndedAt?: string;
}

export type SessionRenameRequest = { sessionId: string; title: string };
export type SessionArchiveRequest = { sessionId: string };

/** Reads `_meta.jetbrains.air.list` of a `session/list` request. Bad values fall back to the defaults. */
export function readSessionIndexListOptions(meta: Record<string, unknown> | null | undefined): SessionIndexListOptions {
    const jetbrains = asRecord(asRecord(meta)[JETBRAINS_META_KEY]);
    const list = asRecord(asRecord(jetbrains[AIR_META_KEY])[AIR_SESSION_LIST_KEY]);
    return {
        limit: clampLimit(list["limit"]),
        archived: list["archived"] === "only" ? "only" : "exclude",
    };
}

function clampLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SESSION_INDEX_LIMIT;
    return Math.min(MAX_SESSION_INDEX_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * The `thread/list` request of the session index.
 *
 * - `cwd` is the cwd and its worktrees, see `linkedWorktreeCwds`, or no filter when the client sent no cwd.
 *   A single cwd goes as a string, as the Codex TUI sends it.
 * - `sourceKinds: []` means the interactive sources, as in the Codex TUI and the Codex app. It leaves out
 *   `codex exec` runs and subagent threads.
 * - `modelProviders: []` means all providers, whatever login the agent has.
 * - `useStateDbOnly` answers from the state DB. Without it, Codex scans and repairs every rollout file.
 */
export function sessionIndexThreadListParams(
    cwds: string[] | null,
    options: SessionIndexListOptions,
    cursor: string | null,
): ThreadListParams {
    return {
        cursor,
        limit: options.limit,
        sortKey: "recency_at",
        archived: options.archived === "only",
        sourceKinds: [],
        modelProviders: [],
        ...(cwds === null ? {} : {cwd: cwds.length === 1 ? cwds[0]! : cwds}),
        useStateDbOnly: true,
    };
}

/**
 * The most `thread/list` pages that one read of the session index asks for. A read that reaches it answers
 * the rows it has with the cursor where it stopped, so the client can go on: the list never ends early.
 */
export const SESSION_INDEX_SCAN_BUDGET_PAGES = 50;

/** The prefix of the adapter cursor of a filtered list, see {@link readSessionIndexPage}. */
const FILTERED_CURSOR_PREFIX = "air-filtered:";

/**
 * A position in a filtered list: the Codex page to read again, and the last row that the client already
 * has. The row is kept by its recency and id rather than by a count, so rows that come or go before it
 * between two requests do not shift the next page.
 */
interface FilteredCursor {
    codexCursor: string | null;
    after: {recency: number, id: string} | null;
}

/**
 * Reads one page of the session index. Codex filters, sorts and limits the page.
 *
 * `keep` filters the rows after the read, for the filters that Codex cannot apply. Such a read asks Codex
 * for the largest pages and cuts the kept rows to the limit, and its cursor is the adapter's: the Codex
 * cursor of the page and the last row that the client already has.
 *
 * A page that has no row left but has a cursor is skipped, so a page with a cursor is not empty. The
 * skipping goes on while the cursor advances, for at most {@link SESSION_INDEX_SCAN_BUDGET_PAGES} pages.
 * Only a filtered list can reach that budget: it then answers an empty page with the cursor where the read
 * stopped. A cursor that Codex already answered means that it does not advance, and only then the list
 * ends early.
 *
 * @throws RequestError `invalidParams` for an adapter cursor that is malformed or belongs to the other kind
 *   of list.
 */
export async function readSessionIndexPage(
    threadList: (params: ThreadListParams) => Promise<ThreadListResponse>,
    cwds: string[] | null,
    options: SessionIndexListOptions,
    cursor: string | null,
    keep?: (thread: Thread) => boolean,
): Promise<{threads: Thread[], nextCursor: string | null}> {
    const filtered = keep !== undefined;
    if (!filtered && cursor?.startsWith(FILTERED_CURSOR_PREFIX)) throw invalidCursorError(cursor);
    const position: FilteredCursor = filtered ? decodeFilteredCursor(cursor) : {codexCursor: cursor, after: null};
    const pageOptions = filtered ? {...options, limit: MAX_SESSION_INDEX_LIMIT} : options;
    const encode = (codexCursor: string) => filtered ? encodeFilteredCursor({codexCursor, after: null}) : codexCursor;
    const readCursors = new Set<string>();
    let pageCursor = position.codexCursor;
    let after = position.after;
    for (let pages = 1; ; pages++) {
        if (pageCursor !== null) readCursors.add(pageCursor);
        const response = await threadList(sessionIndexThreadListParams(cwds, pageOptions, pageCursor));
        const kept = rowsAfter(keep === undefined ? response.data : response.data.filter(keep), after);
        const nextCursor = response.nextCursor ?? null;
        if (filtered && kept.length > options.limit) {
            // The rest of the kept rows of this page come with the next request.
            const threads = kept.slice(0, options.limit);
            const last = threads[threads.length - 1]!;
            return {
                threads,
                nextCursor: encodeFilteredCursor({codexCursor: pageCursor, after: {recency: recencyOf(last), id: last.id}}),
            };
        }
        if (kept.length > 0 || nextCursor === null) {
            return {threads: kept, nextCursor: kept.length === 0 || nextCursor === null ? null : encode(nextCursor)};
        }
        if (readCursors.has(nextCursor)) {
            logger.log("thread/list repeats its cursor; the session list ends here", {cursor: nextCursor});
            return {threads: [], nextCursor: null};
        }
        if (pages >= SESSION_INDEX_SCAN_BUDGET_PAGES) {
            logger.log("The session list read its page budget; the client continues from the cursor", {pages});
            return {threads: [], nextCursor: encode(nextCursor)};
        }
        pageCursor = nextCursor;
        after = null;
    }
}

/** The recency that the session index sorts by, newest first. */
function recencyOf(thread: Thread): number {
    return thread.recencyAt ?? thread.updatedAt;
}

/**
 * The rows of a page that sort after `after`: older ones, and the ones as old that follow it on the page.
 * When `after` is gone from the page, every row as old as it stays: a row may come twice, but none is lost.
 */
function rowsAfter(rows: Thread[], after: FilteredCursor["after"]): Thread[] {
    if (after === null) return rows;
    const sameRecency = rows.filter(row => recencyOf(row) === after.recency);
    const anchorIndex = sameRecency.findIndex(row => row.id === after.id);
    const seen = new Set(anchorIndex < 0 ? [] : sameRecency.slice(0, anchorIndex + 1).map(row => row.id));
    return rows.filter(row => recencyOf(row) < after.recency || (recencyOf(row) === after.recency && !seen.has(row.id)));
}

function encodeFilteredCursor(cursor: FilteredCursor): string {
    const value = [cursor.codexCursor, cursor.after === null ? null : [cursor.after.recency, cursor.after.id]];
    return FILTERED_CURSOR_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Reads an adapter cursor of a filtered list. A cursor without the adapter prefix counts as a Codex cursor. */
function decodeFilteredCursor(cursor: string | null): FilteredCursor {
    if (cursor === null || !cursor.startsWith(FILTERED_CURSOR_PREFIX)) return {codexCursor: cursor, after: null};
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(cursor.slice(FILTERED_CURSOR_PREFIX.length), "base64url").toString("utf8"));
    } catch {
        throw invalidCursorError(cursor);
    }
    if (!Array.isArray(value) || value.length !== 2 || (value[0] !== null && typeof value[0] !== "string")) {
        throw invalidCursorError(cursor);
    }
    const codexCursor = value[0] as string | null;
    const after: unknown = value[1];
    if (after === null) return {codexCursor, after: null};
    if (Array.isArray(after) && after.length === 2 && typeof after[0] === "number" && Number.isFinite(after[0])
        && typeof after[1] === "string") {
        return {codexCursor, after: {recency: after[0], id: after[1]}};
    }
    throw invalidCursorError(cursor);
}

function invalidCursorError(cursor: string): RequestError {
    return RequestError.invalidParams({cursor}, "invalid cursor");
}

/** The session list row of a thread. */
export function sessionIndexSessionInfo(thread: Thread, activity: SessionActivity | null): acp.SessionInfo {
    const airFields: Record<string, unknown> = {};
    const branch = thread.gitInfo?.branch;
    if (branch) airFields[AIR_GIT_BRANCH_KEY] = branch;
    if (activity !== null && (activity.state !== undefined || activity.lastTurnEndedAt !== undefined)) {
        airFields[AIR_ACTIVITY_KEY] = activity;
    }
    let meta: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(airFields)) {
        meta = withAirMeta(meta, key, value);
    }
    return {
        sessionId: thread.id,
        cwd: thread.cwd,
        title: normalizeSessionTitle(thread.name ?? thread.preview),
        updatedAt: new Date((thread.recencyAt ?? thread.updatedAt) * 1000).toISOString(),
        ...(meta ? {_meta: meta} : {}),
    };
}

/**
 * The state of a thread that this app-server has loaded. A thread that is not loaded here belongs to
 * another process or to nobody, so its state is unknown and is omitted.
 */
export function activityStateOf(status: ThreadStatus): SessionActivityState | undefined {
    switch (status.type) {
        case "active":
            return status.activeFlags.length > 0 ? "requires_action" : "running";
        case "idle":
            return "idle";
        case "notLoaded":
        case "systemError":
            return undefined;
    }
}

/**
 * What this adapter knows about the activity of its own threads: the end of the last turn, from
 * `turn/completed`. The state itself comes from `Thread.status` of each `thread/list` answer, which the
 * app-server fills for the threads it has loaded.
 */
export class SessionIndexActivity {
    private readonly lastTurnEndedAt = new Map<string, string>();

    /**
     * @param isSession true for a thread that is a session of this connection. Only those are recorded: the
     *   ephemeral threads of the title generation and other helper threads never show in the list.
     */
    constructor(private readonly isSession: (threadId: string) => boolean = () => true) {}

    observe(notification: ServerNotification): void {
        if (notification.method === "thread/deleted") {
            this.forget(notification.params.threadId);
            return;
        }
        if (notification.method !== "turn/completed" || !this.isSession(notification.params.threadId)) return;
        const completedAt = notification.params.turn.completedAt;
        const endedAt = completedAt === null ? new Date() : new Date(completedAt * 1000);
        this.lastTurnEndedAt.set(notification.params.threadId, endedAt.toISOString());
    }

    activityOf(thread: Thread): SessionActivity | null {
        const state = activityStateOf(thread.status);
        const lastTurnEndedAt = this.lastTurnEndedAt.get(thread.id);
        if (state === undefined && lastTurnEndedAt === undefined) return null;
        return {
            ...(state !== undefined ? {state} : {}),
            ...(lastTurnEndedAt !== undefined ? {lastTurnEndedAt} : {}),
        };
    }

    forget(threadId: string): void {
        this.lastTurnEndedAt.delete(threadId);
    }
}

const SESSION_INDEX_NOTIFICATIONS: ReadonlySet<ServerNotification["method"]> = new Set<ServerNotification["method"]>([
    "thread/started",
    "thread/status/changed",
    "thread/name/updated",
    "thread/archived",
    "thread/unarchived",
    "thread/deleted",
    "thread/closed",
    "turn/started",
    "turn/completed",
]);

/** True for an app-server notification that can change a row of the session index of this process. */
export function changesSessionIndex(notification: ServerNotification): boolean {
    return SESSION_INDEX_NOTIFICATIONS.has(notification.method);
}

/** A value that changes when a row of the page changes in a way the client shows. */
export function sessionIndexPageSignature(sessions: acp.SessionInfo[], nextCursor: string | null | undefined): string {
    return JSON.stringify([
        sessions.map(session => [session.sessionId, session.cwd, session.title, session.updatedAt, session._meta ?? null]),
        nextCursor !== null && nextCursor !== undefined,
    ]);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
