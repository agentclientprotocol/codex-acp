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
import {z} from "zod";
import type {ServerNotification} from "./app-server";
import type {Thread, ThreadListParams, ThreadListResponse, ThreadStatus, Turn} from "./app-server/v2";
import {AIR_META_KEY, JETBRAINS_META_KEY, withAirMeta} from "./AirExtension";
import {listedSessionTitle} from "./SessionTitle";
import {logger} from "./Logger";

export const AIR_SESSION_INDEX_KEY = "sessionIndex";
/** Agent capability: `_session/archive` and `_session/unarchive`. Advertised exactly with `sessionIndex`. */
export const AIR_SESSION_ARCHIVE_KEY = "sessionArchive";
/** Agent capability: `_session/rename`. Advertised exactly with `sessionIndex`. */
export const AIR_SESSION_RENAME_KEY = "sessionRename";
export const SESSION_RENAME_METHOD = "_session/rename";
export const SESSION_ARCHIVE_METHOD = "_session/archive";
export const SESSION_UNARCHIVE_METHOD = "_session/unarchive";
/** Agent capability: `_session/list/subscribe`, `_session/list/unsubscribe` and `_session/list/changes`. */
export const AIR_SESSION_LIST_SUBSCRIBE_KEY = "sessionListSubscribe";
export const SESSION_LIST_SUBSCRIBE_METHOD = "_session/list/subscribe";
export const SESSION_LIST_UNSUBSCRIBE_METHOD = "_session/list/unsubscribe";
export const SESSION_LIST_CHANGES_METHOD = "_session/list/changes";

/** The `_meta.jetbrains.air` key of the list options in a `session/list` request. */
export const AIR_SESSION_LIST_KEY = "list";
export const AIR_STATE_KEY = "state";
export const AIR_LAST_TURN_ENDED_AT_KEY = "lastTurnEndedAt";
export const AIR_LAST_PROMPT_AT_KEY = "lastPromptAt";
export const AIR_MODEL_KEY = "model";
export const AIR_FORKED_FROM_KEY = "forkedFrom";

export const DEFAULT_SESSION_INDEX_LIMIT = 50;
/** The largest page that the adapter asks Codex for. */
export const MAX_SESSION_INDEX_LIMIT = 100;

/** The `_meta.jetbrains.air` key of the archive state of a session list row or `session_info_update`. */
export const AIR_ARCHIVED_KEY = "archived";

/** The `archived` list option: which Codex lists the session index reads. */
export type SessionIndexArchivedFilter = "unarchived" | "archived" | "all";

const ARCHIVED_FILTERS: readonly SessionIndexArchivedFilter[] = ["unarchived", "archived", "all"];

/** The Codex lists of a filter, by their `thread/list` `archived` value, unarchived first. */
function archivedSides(filter: SessionIndexArchivedFilter): boolean[] {
    switch (filter) {
        case "unarchived":
            return [false];
        case "archived":
            return [true];
        case "all":
            return [false, true];
    }
}

function isArchivedFilter(value: unknown): value is SessionIndexArchivedFilter {
    return typeof value === "string" && (ARCHIVED_FILTERS as readonly string[]).includes(value);
}

export interface SessionIndexListOptions {
    limit: number;
    /** `unarchived` or `archived`: that Codex list only. `all`: both in one list. */
    archived: SessionIndexArchivedFilter;
    /** Also list the sessions of the linked Git worktrees of the cwd. */
    includeWorktrees: boolean;
}

/** A thread of the session index and whether it is archived. */
export interface SessionIndexThread {
    thread: Thread;
    archived: boolean;
}

export type SessionActivityState = "running" | "idle" | "requires_action" | "reviewing" | "error";

export interface SessionActivity {
    state?: SessionActivityState;
    lastTurnEndedAt?: string;
}

export type SessionRenameRequest = { sessionId: string; title: string };
export type SessionArchiveRequest = { sessionId: string };

export const sessionRenameParamsParser = z.object({
    sessionId: z.string(),
    title: z.string(),
}).passthrough();

export const sessionArchiveParamsParser = z.object({
    sessionId: z.string(),
}).passthrough();

/** The params of `_session/list/subscribe` and `_session/list/unsubscribe`, which the service validates. */
export const sessionListSubscriptionParamsParser = z.preprocess(
    (params) => params ?? {},
    z.record(z.string(), z.unknown()),
);

/**
 * Reads `_meta.jetbrains.air.list` of a `session/list` request.
 *
 * @throws RequestError `invalidParams` for a `limit` that is not an integer of at least 1, an `archived` that is
 *   not `"unarchived"`, `"archived"` or `"all"`, or an `includeWorktrees` that is not a boolean. Omitted and
 *   `null` mean the default for each.
 */
export function readSessionIndexListOptions(meta: Record<string, unknown> | null | undefined): SessionIndexListOptions {
    const jetbrains = asRecord(asRecord(meta)[JETBRAINS_META_KEY]);
    const list = asRecord(asRecord(jetbrains[AIR_META_KEY])[AIR_SESSION_LIST_KEY]);
    return {
        limit: readLimit(list["limit"]),
        archived: readArchivedFilter(list["archived"]),
        includeWorktrees: readBoolean(list, "includeWorktrees"),
    };
}

/** A boolean list option: omitted and `null` are `false`, anything else that is not a boolean is an error. */
function readBoolean(list: Record<string, unknown>, key: string): boolean {
    const value = list[key] ?? false;
    if (typeof value !== "boolean") {
        throw RequestError.invalidParams({[key]: value}, `${key} must be a boolean`);
    }
    return value;
}

/** `archived`: omitted or `null` is `"unarchived"`, anything else that is not a filter name is an error. */
function readArchivedFilter(value: unknown): SessionIndexArchivedFilter {
    if (value === undefined || value === null) return "unarchived";
    if (!isArchivedFilter(value)) {
        throw RequestError.invalidParams({archived: value}, `archived must be one of ${ARCHIVED_FILTERS.map(filter => `"${filter}"`).join(", ")}`);
    }
    return value;
}

/** `limit`: omitted or `null` is the default, an integer of at least 1 is clamped to the maximum. */
function readLimit(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_SESSION_INDEX_LIMIT;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw RequestError.invalidParams({limit: value}, "limit must be an integer of at least 1");
    }
    return Math.min(MAX_SESSION_INDEX_LIMIT, value);
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
    limit: number,
    archived: boolean,
    cursor: string | null,
): ThreadListParams {
    return {
        cursor,
        limit,
        sortKey: "recency_at",
        archived,
        sourceKinds: [],
        modelProviders: [],
        ...(cwds === null ? {} : {cwd: cwds.length === 1 ? cwds[0]! : cwds}),
        useStateDbOnly: true,
    };
}

/**
 * The most rounds of `thread/list` reads that one read of the session index makes, and the longest time it
 * starts new ones. A read that reaches either answers the rows it has with the cursor where it stopped, so
 * the client can go on: the list never ends early.
 */
export const SESSION_INDEX_SCAN_BUDGET_PAGES = 50;
export const SESSION_INDEX_SCAN_BUDGET_MS = 300;

/** The prefix of the adapter cursor, see {@link readSessionIndexPage}. */
const ADAPTER_CURSOR_PREFIX = "air-list:";

/** Where one Codex list, the unarchived or the archived threads, goes on. Which one follows from the filter. */
interface SideCursor {
    /** The Codex page to read, read again when the client has not got all its rows yet. */
    codexCursor: string | null;
    /** Codex has no more rows. */
    done: boolean;
}

/**
 * The adapter cursor. The last rows that the client has are kept by their recency and ids rather than by a
 * count, so rows that come or go between two requests do not shift the next page.
 */
interface AdapterCursor {
    /** The requested cwd, or `null` for a list without one. */
    scope: string | null;
    archived: SessionIndexArchivedFilter;
    includeWorktrees: boolean;
    filtered: boolean;
    /** One per Codex list of the filter, in the order of {@link archivedSides}. */
    sides: SideCursor[];
    /** The recency of the last row that the client has, and the ids of its rows with that recency. */
    after: {recency: number, ids: string[]} | null;
}

interface SidePage {
    rows: Thread[];
    nextCursor: string | null;
    /** The recency of the oldest row of the Codex page, before any filter. `null` for an empty page. */
    oldest: number | null;
}

/**
 * Reads one page of the session index, newest first.
 *
 * Codex lists the unarchived and the archived threads apart. `archived: "unarchived"` and `"archived"` read
 * one of the two lists; `"all"` reads both and merges them, ties unarchived first. It answers a row only
 * when no unread Codex page can hold a newer one. `keep` filters the rows after the read, for the filters
 * that Codex cannot apply; such a read asks Codex for the largest pages and cuts the kept rows to the limit.
 *
 * The cursor is the adapter's: the Codex pages to read next and the last rows that the client has, kept by
 * their recency and ids rather than by a count, so rows that come or go between two requests do not shift
 * the next page. It is tied to the cwd, `archived`, `includeWorktrees` and the filtering.
 *
 * A page that has no row left but has a cursor is skipped, so a page with a cursor is not empty. The
 * skipping goes on while the cursors advance, for at most {@link SESSION_INDEX_SCAN_BUDGET_PAGES} rounds of
 * Codex reads. A read that reaches that budget, in practice only a filtered one, answers an empty page with
 * the cursor where it stopped. A Codex cursor that Codex already answered means that it does not advance,
 * and only then that Codex list ends early.
 *
 * @param scope The requested cwd, which the cursor is tied to as well. `limit` may change between pages.
 * @throws RequestError `invalidParams` for a cursor that is malformed or belongs to another list.
 */
export async function readSessionIndexPage(
    threadList: (params: ThreadListParams) => Promise<ThreadListResponse>,
    cwds: string[] | null,
    options: SessionIndexListOptions,
    cursor: string | null,
    keep?: (thread: Thread) => boolean,
    scope: string | null = null,
): Promise<{threads: SessionIndexThread[], nextCursor: string | null}> {
    const filtered = keep !== undefined;
    const state: AdapterCursor = cursor === null
        ? {
            scope,
            archived: options.archived,
            includeWorktrees: options.includeWorktrees,
            filtered,
            sides: archivedSides(options.archived).map(() => ({codexCursor: null, done: false})),
            after: null,
        }
        : decodeAdapterCursor(cursor);
    if (state.scope !== scope || state.archived !== options.archived
        || state.includeWorktrees !== options.includeWorktrees || state.filtered !== filtered) {
        throw invalidCursorError(cursor!);
    }

    const pageLimit = filtered ? MAX_SESSION_INDEX_LIMIT : options.limit;
    const sideFlags = archivedSides(state.archived);
    const sideArchived = (index: number): boolean => sideFlags[index]!;
    const readCursors = state.sides.map(side => new Set(side.codexCursor === null ? [] : [side.codexCursor]));
    const pages = new Map<number, SidePage>();
    /** Moves a Codex list on to its next page, or ends it. */
    const advanceSide = (index: number, nextCursor: string | null): void => {
        const side = state.sides[index]!;
        if (nextCursor === null) {
            side.done = true;
        } else if (readCursors[index]!.has(nextCursor)) {
            logger.log("thread/list repeats its cursor; that list ends here", {cursor: nextCursor, archived: sideArchived(index)});
            side.done = true;
        } else {
            readCursors[index]!.add(nextCursor);
            side.codexCursor = nextCursor;
        }
    };

    // A filtered list gathers rows from several Codex pages to fill the page: its matches can be sparse.
    const collected: SessionIndexThread[] = [];
    const startedAt = Date.now();
    const answer = (): {threads: SessionIndexThread[], nextCursor: string | null} => ({
        threads: collected,
        nextCursor: state.sides.every(side => side.done) ? null : encodeAdapterCursor(state),
    });
    const overBudget = (round: number): boolean => {
        if (round < SESSION_INDEX_SCAN_BUDGET_PAGES && Date.now() - startedAt < SESSION_INDEX_SCAN_BUDGET_MS) return false;
        if (collected.length === 0) {
            logger.log("The session list read its scan budget; the client continues from the cursor", {rounds: round});
        }
        return true;
    };

    for (let round = 1; ; round++) {
        // With `all`, the unarchived and the archived lists are read at the same time.
        await Promise.all([...state.sides.entries()].map(async ([index, side]) => {
            if (side.done || pages.has(index)) return;
            const response = await threadList(sessionIndexThreadListParams(cwds, pageLimit, sideArchived(index), side.codexCursor));
            const recencies = response.data.map(recencyOf);
            pages.set(index, {
                rows: rowsAfter(keep === undefined ? response.data : response.data.filter(keep), state.after),
                nextCursor: response.nextCursor ?? null,
                oldest: recencies.length === 0 ? null : Math.min(...recencies),
            });
        }));
        // An empty Codex page with more pages says nothing about how new the rows of its list are, so no row of
        // the other list can be answered before that list's next page is read.
        const unresolved = [...pages].filter(([, page]) => page.oldest === null && page.nextCursor !== null);
        if (unresolved.length > 0) {
            for (const [index, page] of unresolved) {
                pages.delete(index);
                advanceSide(index, page.nextCursor!);
            }
            if (state.sides.every(side => side.done) || overBudget(round)) return answer();
            continue;
        }
        // A row older than the oldest row of a Codex page with more pages could still come after a newer row
        // of that list's next page.
        let bound = -Infinity;
        for (const [index, page] of pages) {
            if (!state.sides[index]!.done && page.nextCursor !== null && page.oldest !== null) {
                bound = Math.max(bound, page.oldest);
            }
        }
        // Sides in their own order, not in the order their responses arrived, so ties come out the same way.
        const candidates = [...pages].sort(([left], [right]) => left - right).flatMap(([index, page]) => page.rows
            .filter(row => recencyOf(row) >= bound)
            .map(thread => ({thread, archived: sideArchived(index), index})));
        // A stable sort: rows as recent as each other keep the Codex order, unarchived first.
        candidates.sort((left, right) => recencyOf(right.thread) - recencyOf(left.thread));
        const taken = candidates.slice(0, options.limit - collected.length);
        const takenIds = new Set(taken.map(row => row.thread.id));

        // A Codex page whose rows the client now has, or which had none to give, is done with.
        for (const [index, page] of [...pages]) {
            const allTaken = (page.oldest === null || page.oldest >= bound) && page.rows.every(row => takenIds.has(row.id));
            if (!allTaken) continue;
            pages.delete(index);
            advanceSide(index, page.nextCursor);
        }
        if (taken.length > 0) {
            const last = recencyOf(taken[taken.length - 1]!.thread);
            const ids = taken.filter(row => recencyOf(row.thread) === last).map(row => row.thread.id);
            state.after = {
                recency: last,
                ids: state.after?.recency === last ? [...state.after.ids, ...ids] : ids,
            };
            collected.push(...taken.map(({thread, archived}) => ({thread, archived})));
            // The Codex pages kept for the next round still hold no taken row: those were all at or above
            // the bound, and a page is kept only for its rows below it.
            for (const page of pages.values()) page.rows = rowsAfter(page.rows, state.after);
        }
        const finished = state.sides.every(side => side.done);
        // An unfiltered list answers after the first round that gives rows: its Codex pages are full.
        if (finished || collected.length >= options.limit || (collected.length > 0 && !filtered)) return answer();
        if (overBudget(round)) return answer();
    }
}

/** The recency that the session index sorts by, newest first: `lastPromptAt ?? updatedAt`, as Codex sorts. */
function recencyOf(thread: Thread): number {
    return thread.recencyAt ?? thread.updatedAt;
}

/** The rows that the client does not have yet: older than `after`, or as old and not among its ids. */
function rowsAfter(rows: Thread[], after: AdapterCursor["after"]): Thread[] {
    if (after === null) return rows;
    const seen = new Set(after.ids);
    return rows.filter(row => recencyOf(row) < after.recency || (recencyOf(row) === after.recency && !seen.has(row.id)));
}

function encodeAdapterCursor(cursor: AdapterCursor): string {
    const value = [
        cursor.scope,
        cursor.archived,
        cursor.includeWorktrees,
        cursor.filtered,
        cursor.sides.map(side => side.done ? 0 : [side.codexCursor]),
        cursor.after === null ? null : [cursor.after.recency, cursor.after.ids],
    ];
    return ADAPTER_CURSOR_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Reads an adapter cursor. A Codex cursor, or any other string, is an error. */
function decodeAdapterCursor(cursor: string): AdapterCursor {
    if (!cursor.startsWith(ADAPTER_CURSOR_PREFIX)) throw invalidCursorError(cursor);
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(cursor.slice(ADAPTER_CURSOR_PREFIX.length), "base64url").toString("utf8"));
    } catch {
        throw invalidCursorError(cursor);
    }
    if (!Array.isArray(value) || value.length !== 6) throw invalidCursorError(cursor);
    const [scope, archived, includeWorktrees, filtered, sides, after] = value as unknown[];
    if ((scope !== null && typeof scope !== "string") || !isArchivedFilter(archived) || typeof includeWorktrees !== "boolean" || typeof filtered !== "boolean"
        || !Array.isArray(sides) || sides.length !== archivedSides(archived).length) {
        throw invalidCursorError(cursor);
    }
    const sideCursors = sides.map((side: unknown): SideCursor => {
        if (side === 0) return {codexCursor: null, done: true};
        if (Array.isArray(side) && side.length === 1 && (side[0] === null || typeof side[0] === "string")) {
            return {codexCursor: side[0] as string | null, done: false};
        }
        throw invalidCursorError(cursor);
    });
    const common = {scope: scope as string | null, archived, includeWorktrees, filtered, sides: sideCursors};
    if (after === null) return {...common, after: null};
    if (Array.isArray(after) && after.length === 2 && typeof after[0] === "number" && Number.isFinite(after[0])
        && Array.isArray(after[1]) && after[1].every((id: unknown) => typeof id === "string")) {
        return {...common, after: {recency: after[0], ids: after[1] as string[]}};
    }
    throw invalidCursorError(cursor);
}

function invalidCursorError(cursor: string): RequestError {
    return RequestError.invalidParams({cursor}, "invalid cursor");
}

/** The session list row of a thread. */
export function sessionIndexSessionInfo(
    thread: Thread,
    archived: boolean,
    activity: SessionActivity | null,
): acp.SessionInfo {
    const airFields: Record<string, unknown> = {[AIR_ARCHIVED_KEY]: archived};
    // Codex moves `recencyAt` when a turn starts and orders threads by it: the time of the last prompt.
    if (thread.recencyAt !== null) airFields[AIR_LAST_PROMPT_AT_KEY] = isoTime(thread.recencyAt);
    if (thread.model) airFields[AIR_MODEL_KEY] = thread.model;
    if (thread.forkedFromId) airFields[AIR_FORKED_FROM_KEY] = thread.forkedFromId;
    // `state` is omitted when unknown, never "unknown".
    if (activity?.state !== undefined) airFields[AIR_STATE_KEY] = activity.state;
    if (activity?.lastTurnEndedAt !== undefined) airFields[AIR_LAST_TURN_ENDED_AT_KEY] = activity.lastTurnEndedAt;
    let meta: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(airFields)) {
        meta = withAirMeta(meta, key, value);
    }
    return {
        sessionId: thread.id,
        cwd: thread.cwd,
        title: listedSessionTitle(thread),
        // Codex moves `Thread.updatedAt` for every rollout write of the user or the agent: the last activity of any
        // kind. The list is ordered by `lastPromptAt ?? updatedAt` instead. Known deviation from #2161: Codex also
        // moves it on `thread/unarchive`, which sets the rollout mtime to now (thread-store unarchive_thread.rs).
        updatedAt: isoTime(thread.updatedAt),
        ...(meta ? {_meta: meta} : {}),
    };
}

/** The ISO time of a Codex time in seconds. */
function isoTime(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
}

/**
 * The state of a thread that this app-server has loaded. A thread that is not loaded here belongs to
 * another process or to nobody, so its state is unknown and is omitted.
 */
export function activityStateOf(
    status: ThreadStatus,
    lastTurnFailed = false,
    reviewing = false,
): SessionActivityState | undefined {
    if (status.type === "notLoaded") return undefined;
    // requires_action > reviewing > running > error > idle.
    if (status.type === "active" && status.activeFlags.length > 0) return "requires_action";
    if (status.type === "active") return reviewing ? "reviewing" : "running";
    if (status.type === "systemError" || lastTurnFailed) return "error";
    return "idle";
}

/** A turn that ended with an error rather than a user cancel: `failed`, or another end with an error. */
export function turnFailed(turn: Turn): boolean {
    return turn.status === "failed" || (turn.status !== "interrupted" && turn.status !== "inProgress" && turn.error !== null);
}

/**
 * What this adapter knows about the activity of its own threads: the end of the last turn, from
 * `turn/completed`. The state itself comes from `Thread.status` of each `thread/list` answer, which the
 * app-server fills for the threads it has loaded.
 */
export class SessionIndexActivity {
    private readonly lastTurnEndedAt = new Map<string, string>();
    /** Threads loaded here whose last turn ended with an error; a new turn clears it. */
    private readonly failed = new Set<string>();
    /** Threads loaded here in Codex review mode: from an `enteredReviewMode` item to its `exitedReviewMode`. */
    private readonly reviewing = new Set<string>();

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
        if (notification.method === "item/started" || notification.method === "item/completed") {
            const type = notification.params.item.type;
            if (type === "enteredReviewMode") this.reviewing.add(notification.params.threadId);
            if (type === "exitedReviewMode") this.reviewing.delete(notification.params.threadId);
            return;
        }
        // A new turn, and a thread that is no longer loaded here, start over: the thread can go on elsewhere.
        if (notification.method === "turn/started" || notification.method === "thread/closed"
            || (notification.method === "thread/status/changed" && notification.params.status.type === "notLoaded")) {
            this.failed.delete(notification.params.threadId);
            this.reviewing.delete(notification.params.threadId);
            return;
        }
        if (notification.method !== "turn/completed") return;
        // A review ends with its turn, also one that failed or was cancelled before its exit item.
        this.reviewing.delete(notification.params.threadId);
        if (turnFailed(notification.params.turn)) this.failed.add(notification.params.threadId);
        else this.failed.delete(notification.params.threadId);
        if (!this.isSession(notification.params.threadId)) return;
        const completedAt = notification.params.turn.completedAt;
        const endedAt = completedAt === null ? new Date() : new Date(completedAt * 1000);
        this.lastTurnEndedAt.set(notification.params.threadId, endedAt.toISOString());
    }

    activityOf(thread: Thread): SessionActivity | null {
        const state = activityStateOf(thread.status, this.failed.has(thread.id), this.reviewing.has(thread.id));
        const lastTurnEndedAt = this.lastTurnEndedAt.get(thread.id);
        if (state === undefined && lastTurnEndedAt === undefined) return null;
        return {
            ...(state !== undefined ? {state} : {}),
            ...(lastTurnEndedAt !== undefined ? {lastTurnEndedAt} : {}),
        };
    }

    /** The app-server went away: what its turns said of its loaded threads no longer holds. */
    resetLoaded(): string[] {
        const threadIds = [...new Set([...this.failed, ...this.reviewing])];
        this.failed.clear();
        this.reviewing.clear();
        return threadIds;
    }

    forget(threadId: string): void {
        this.lastTurnEndedAt.delete(threadId);
        this.failed.delete(threadId);
        this.reviewing.delete(threadId);
    }
}

/**
 * What the client shows of a row, without `updatedAt`: a row whose signature did not change is not sent again.
 * `title` and the AIR fields `lastPromptAt`, `state`, `lastTurnEndedAt`, `model`, `forkedFrom` and `archived`.
 */
export function sessionIndexRowSignature(row: acp.SessionInfo): string {
    const air = asRecord(asRecord(asRecord(row._meta)[JETBRAINS_META_KEY])[AIR_META_KEY]);
    return JSON.stringify([
        row.title ?? null,
        air[AIR_LAST_PROMPT_AT_KEY] ?? null,
        air[AIR_STATE_KEY] ?? null,
        air[AIR_LAST_TURN_ENDED_AT_KEY] ?? null,
        air[AIR_MODEL_KEY] ?? null,
        air[AIR_FORKED_FROM_KEY] ?? null,
        air[AIR_ARCHIVED_KEY] ?? null,
    ]);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
