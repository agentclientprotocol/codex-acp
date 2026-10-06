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
import type {ServerNotification} from "./app-server";
import type {Thread, ThreadListParams, ThreadListResponse, ThreadStatus} from "./app-server/v2";
import {AIR_META_KEY, JETBRAINS_META_KEY, withAirMeta} from "./AirExtension";
import {normalizeSessionTitle} from "./SessionTitle";

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
/**
 * How many more `thread/list` pages one `session/list` reads when Codex
 * answers an empty page with a cursor. A page with a cursor is never empty.
 */
const MAX_EMPTY_PAGE_SKIPS = 10;

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
 * Reads one page of the session index. Codex filters, sorts and limits the page.
 * An empty page with a cursor is skipped, so a page with a cursor is never empty.
 */
export async function readSessionIndexPage(
    threadList: (params: ThreadListParams) => Promise<ThreadListResponse>,
    cwds: string[] | null,
    options: SessionIndexListOptions,
    cursor: string | null,
): Promise<{threads: Thread[], nextCursor: string | null}> {
    let response = await threadList(sessionIndexThreadListParams(cwds, options, cursor));
    for (let skips = 0; response.data.length === 0 && response.nextCursor && skips < MAX_EMPTY_PAGE_SKIPS; skips++) {
        response = await threadList(sessionIndexThreadListParams(cwds, options, response.nextCursor));
    }
    return {
        threads: response.data,
        nextCursor: response.data.length === 0 ? null : response.nextCursor ?? null,
    };
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

    observe(notification: ServerNotification): void {
        if (notification.method !== "turn/completed") return;
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
