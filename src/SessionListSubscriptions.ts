/**
 * `_session/list/subscribe`: the rows of the session list of a cwd that changed, pushed to the client as
 * `_session/list/changes`. Best effort: the client also re-reads the list now and then.
 *
 * A subscription covers the threads of its cwd and of the same subdirectory in the primary checkout and each
 * linked worktree, from the interactive sources, archived or not. Subscriptions of one cwd share one group:
 * the rows last computed for its threads. Each subscription keeps the signature of the rows it was sent, so
 * it gets a row when it differs from the one it has, and never one that differs only in `updatedAt`.
 *
 * Changes come from two places:
 * - The thread notifications of this adapter's app-server. Each names a thread, which is read with
 *   `thread/read` right away.
 * - Any Codex process: a write of the state DB WAL, seen by {@link CodexHomeWatcher}. After a quiet time, one
 *   `thread/list` per archive state, by `updated_at` and without cwd, reads the threads that changed since
 *   the newest one seen before. A rename moves no `updated_at`, so the renames of the session name log are
 *   read with `thread/read`, and so are the threads whose rollout moved in or out of `archived_sessions`.
 *
 * A thread is sent at most once a second; one flush sends one notification per subscription.
 */

import {randomUUID} from "node:crypto";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {ServerNotification} from "./app-server";
import type {Thread, ThreadListParams, ThreadListResponse, ThreadReadParams, ThreadReadResponse} from "./app-server/v2";
import {CodexHomeWatcher, type CodexHomeWatcherListener} from "./CodexHomeWatcher";
import {logger} from "./Logger";
import {sessionIndexRowSignature} from "./SessionIndex";
import {isArchivedRolloutPath, isMissingThreadError} from "./SessionIndexMutations";
import {SessionNameLog} from "./SessionNameLog";

/** The most subscriptions of one connection. */
export const MAX_SESSION_LIST_SUBSCRIPTIONS = 128;
export const TOO_MANY_SUBSCRIPTIONS_REASON = "too_many_subscriptions";

export interface SessionListSubscriptionTimings {
    /** The quiet time after the last WAL event before the scan. */
    quietMs: number;
    /** The longest time between the first WAL event and its scan. */
    maxWaitMs: number;
    /** How long a notification of the own app-server waits for the ones that come with it. */
    ownChangeDelayMs: number;
    /** The shortest time between two changes of one thread. */
    minChangeIntervalMs: number;
    /** How often the WAL size and time are checked without an event. */
    fallbackIntervalMs: number;
}

export const DEFAULT_SESSION_LIST_SUBSCRIPTION_TIMINGS: SessionListSubscriptionTimings = {
    quietMs: 150,
    maxWaitMs: 1_000,
    ownChangeDelayMs: 20,
    minChangeIntervalMs: 1_000,
    fallbackIntervalMs: 30_000,
};

/** The rows that a scan reads first, and then per page. */
const SCAN_FIRST_PAGE = 20;
const SCAN_NEXT_PAGE = 100;
/** The most pages of one scan. Changes beyond them are not sent. */
const SCAN_MAX_PAGES = 10;
/** The most baseline rows of a group, per archive state. */
const BASELINE_ROWS = 50;
/** The most `thread/read` requests at a time. */
const READ_CONCURRENCY = 8;
/** The most helper threads remembered as not listed. */
const MAX_IGNORED_THREADS = 256;
/** The shortest time between two resolutions of the worktrees of the groups. */
const SCOPE_REFRESH_MS = 10_000;

export interface SessionListChanges {
    subscriptionId: string;
    sessions: acp.SessionInfo[];
    removed: string[];
}

/** The app-server requests that the subscriptions need. */
export interface SessionListReader {
    threadList(params: ThreadListParams): Promise<ThreadListResponse>;
    threadRead(params: ThreadReadParams): Promise<ThreadReadResponse>;
}

export interface SessionListSubscriptionDeps {
    /** The app-server to read from, or `null` when none runs: then nothing is read. */
    reader(): SessionListReader | null;
    /** CODEX_HOME, or `null` when the app-server did not report it: then only own notifications count. */
    codexHome(): string | null;
    /** The rows of threads, in their order, exactly as `session/list` answers them. */
    rows(threads: ThreadEntry[]): Promise<acp.SessionInfo[]>;
    /** The cwds whose threads a subscription of `cwd` covers. */
    scopeCwds(cwd: string): string[];
    notify(changes: SessionListChanges): Promise<void>;
    /** Starts watching CODEX_HOME; a {@link CodexHomeWatcher} unless a test replaces it. */
    watchCodexHome?: (home: string, listener: CodexHomeWatcherListener, fallbackIntervalMs: number) => {stop(): void};
    timings?: SessionListSubscriptionTimings;
    now?: () => number;
}

interface Group {
    cwd: string;
    scope: Set<string>;
    subscriptions: Set<Subscription>;
    /** The signature of the row last computed for each thread of the scope that the group has seen. */
    rows: Map<string, string>;
    /** Resolves when the baseline rows are read. Never rejects. */
    ready: Promise<void>;
}

interface Subscription {
    id: string;
    group: Group;
    /** The signature of the row that the client has for each thread: the baseline, then what was sent. */
    sent: Map<string, string>;
}

export interface ThreadEntry {
    thread: Thread;
    archived: boolean;
}

export class SessionListSubscriptions {
    private readonly subscriptions = new Map<string, Subscription>();
    private readonly groups = new Map<string, Group>();
    private readonly timings: SessionListSubscriptionTimings;
    private readonly now: () => number;

    private watcher: {stop(): void} | null = null;
    private nameLog: SessionNameLog | null = null;
    /** The newest `updatedAt` that a scan saw, per archive state; `null` before the first scan. */
    private marks: {unarchived: number, archived: number} | null = null;
    private marksReady: Promise<void> | null = null;
    /** Moves on when the watching stops, so that a scan that was running then does not set the marks again. */
    private watchGeneration = 0;

    /** Threads to read with `thread/read` in the next flush. */
    private readonly pendingThreads = new Set<string>();
    /** Threads whose row may have changed without a change of the thread, such as its usage, see {@link rowsChanged}. */
    private readonly pendingEntries = new Map<string, ThreadEntry>();
    /** Deleted threads, with whether this adapter deleted them: then a client that never got the row hears of it too. */
    private readonly deletedThreads = new Map<string, boolean>();
    private scanRequested = false;
    private firstStateChangeAt: number | null = null;
    private scanDueAt: number | null = null;
    private threadsDueAt: number | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timerDueAt: number | null = null;
    private flushing: Promise<void> | null = null;
    /** When each thread last went out, for {@link SessionListSubscriptionTimings.minChangeIntervalMs}. */
    private readonly lastChangeAt = new Map<string, number>();
    /** Threads of the own app-server that the list never shows: ephemeral, subagent and other helper threads. */
    private readonly ignoredThreads = new Set<string>();
    private scopesRefreshedAt = 0;
    private disposed = false;

    constructor(private readonly deps: SessionListSubscriptionDeps) {
        this.timings = deps.timings ?? DEFAULT_SESSION_LIST_SUBSCRIPTION_TIMINGS;
        this.now = deps.now ?? Date.now;
    }

    /**
     * Starts a subscription of an absolute cwd. Resolves when the rows that the client is assumed to have, the
     * most recently updated ones of the scope, are read: a change after that is sent.
     *
     * @throws RequestError `invalidParams` with `data.reason: "too_many_subscriptions"` beyond
     *   {@link MAX_SESSION_LIST_SUBSCRIPTIONS}.
     */
    async subscribe(cwd: string): Promise<string> {
        if (this.disposed) throw RequestError.internalError(undefined, "The connection is closed");
        if (this.subscriptions.size >= MAX_SESSION_LIST_SUBSCRIPTIONS) {
            throw RequestError.invalidParams(
                {reason: TOO_MANY_SUBSCRIPTIONS_REASON, max: MAX_SESSION_LIST_SUBSCRIPTIONS},
                `At most ${MAX_SESSION_LIST_SUBSCRIPTIONS} session list subscriptions per connection`,
            );
        }
        const key = path.resolve(cwd);
        let group = this.groups.get(key);
        if (group === undefined) {
            const created: Group = {
                cwd: key,
                scope: new Set(this.deps.scopeCwds(key)),
                subscriptions: new Set(),
                rows: new Map(),
                ready: Promise.resolve(),
            };
            created.ready = this.readBaseline(created);
            this.groups.set(key, created);
            group = created;
        }
        const subscription: Subscription = {id: randomUUID(), group, sent: new Map()};
        this.subscriptions.set(subscription.id, subscription);
        group.subscriptions.add(subscription);
        this.startWatching();
        await Promise.all([group.ready, this.marksReady]);
        subscription.sent = new Map(group.rows);
        return subscription.id;
    }

    /** Ends a subscription. Idempotent: an unknown id changes nothing. */
    unsubscribe(subscriptionId: string): void {
        const subscription = this.subscriptions.get(subscriptionId);
        if (subscription === undefined) return;
        this.subscriptions.delete(subscriptionId);
        const group = subscription.group;
        group.subscriptions.delete(subscription);
        if (group.subscriptions.size === 0 && this.groups.get(group.cwd) === group) this.groups.delete(group.cwd);
        if (this.subscriptions.size === 0) this.stopWatching();
    }

    /** Ends every subscription: the connection is gone. */
    dispose(): void {
        this.disposed = true;
        this.subscriptions.clear();
        this.groups.clear();
        this.stopWatching();
    }

    /** The number of subscriptions, groups and open watches and timers. For tests. */
    resources(): {subscriptions: number, groups: number, watching: boolean, timer: boolean} {
        return {
            subscriptions: this.subscriptions.size,
            groups: this.groups.size,
            watching: this.watcher !== null,
            timer: this.timer !== null,
        };
    }

    /** A notification of the own app-server. */
    observe(notification: ServerNotification): void {
        if (this.subscriptions.size === 0) return;
        switch (notification.method) {
            case "thread/started": {
                const thread = notification.params.thread;
                if (thread.ephemeral || !isInteractiveSource(thread)) {
                    this.ignore(thread.id);
                    return;
                }
                this.threadChanged(thread.id);
                return;
            }
            case "thread/deleted":
                this.pendingThreads.delete(notification.params.threadId);
                this.deletedThreads.set(notification.params.threadId, true);
                this.requestThreads(this.timings.ownChangeDelayMs);
                return;
            case "thread/status/changed":
            case "thread/name/updated":
            case "thread/archived":
            case "thread/unarchived":
            case "thread/closed":
            case "turn/started":
            case "turn/completed":
            case "thread/tokenUsage/updated":
                if (!this.ignoredThreads.has(notification.params.threadId)) this.threadChanged(notification.params.threadId);
                return;
            default:
                return;
        }
    }

    /** The rows of these threads may have changed, though the threads did not: their usage was read. */
    rowsChanged(entries: ThreadEntry[]): void {
        if (this.subscriptions.size === 0) return;
        for (const entry of entries) this.pendingEntries.set(entry.thread.id, entry);
        this.requestThreads(0);
    }

    private threadChanged(threadId: string): void {
        this.pendingThreads.add(threadId);
        this.requestThreads(this.timings.ownChangeDelayMs);
    }

    private ignore(threadId: string): void {
        this.ignoredThreads.add(threadId);
        if (this.ignoredThreads.size > MAX_IGNORED_THREADS) {
            const oldest = this.ignoredThreads.values().next().value;
            if (oldest !== undefined) this.ignoredThreads.delete(oldest);
        }
    }

    /** A state DB WAL changed: scan after the quiet time. */
    private stateChanged(): void {
        if (this.subscriptions.size === 0) return;
        const now = this.now();
        this.scanRequested = true;
        this.firstStateChangeAt ??= now;
        this.scanDueAt = Math.min(now + this.timings.quietMs, this.firstStateChangeAt + this.timings.maxWaitMs);
        this.arm();
    }

    private requestThreads(delayMs: number): void {
        if (this.subscriptions.size === 0) return;
        const due = this.now() + delayMs;
        this.threadsDueAt = this.threadsDueAt === null ? due : Math.min(this.threadsDueAt, due);
        this.arm();
    }

    /** Sets the timer to the earliest flush that is due. A running flush arms it again when it ends. */
    private arm(): void {
        if (this.disposed || this.flushing !== null) return;
        const due = Math.min(this.scanDueAt ?? Infinity, this.threadsDueAt ?? Infinity);
        if (due === Infinity) return;
        if (this.timer !== null && this.timerDueAt === due) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timerDueAt = due;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.timerDueAt = null;
            this.flushing = this.flush().finally(() => {
                this.flushing = null;
                this.arm();
            });
        }, Math.max(0, due - this.now()));
        this.timer.unref?.();
    }

    private startWatching(): void {
        if (this.marksReady === null) {
            this.marksReady = this.withReader(async (reader) => {
                await this.scan(reader);
            });
        }
        if (this.watcher !== null) return;
        const home = this.deps.codexHome();
        if (home === null) return;
        this.nameLog = new SessionNameLog(home);
        const watch = this.deps.watchCodexHome
            ?? ((watchedHome, listener, fallbackIntervalMs) => new CodexHomeWatcher(watchedHome, listener, fallbackIntervalMs));
        this.watcher = watch(home, {
            stateChanged: () => this.stateChanged(),
            archiveMoved: (threadId) => {
                if (this.subscriptions.size === 0) return;
                this.pendingThreads.add(threadId);
                this.stateChanged();
            },
        }, this.timings.fallbackIntervalMs);
    }

    private stopWatching(): void {
        this.watcher?.stop();
        this.watcher = null;
        this.nameLog = null;
        this.marks = null;
        this.marksReady = null;
        this.watchGeneration++;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.timerDueAt = null;
        this.scanRequested = false;
        this.firstStateChangeAt = null;
        this.scanDueAt = null;
        this.threadsDueAt = null;
        this.pendingThreads.clear();
        this.pendingEntries.clear();
        this.deletedThreads.clear();
        this.lastChangeAt.clear();
        this.ignoredThreads.clear();
    }

    /** Runs a read with the running app-server; logs and skips it when there is none or it fails. */
    private async withReader(read: (reader: SessionListReader) => Promise<void>): Promise<void> {
        const reader = this.deps.reader();
        if (reader === null) return;
        try {
            await read(reader);
        } catch (error) {
            logger.log("Session list subscription read failed", {error: String(error)});
        }
    }

    /** The most recently updated rows of a new group, unarchived and archived: what its client has. */
    private async readBaseline(group: Group): Promise<void> {
        await this.withReader(async (reader) => {
            const pages = await Promise.all([false, true].map(archived => reader.threadList({
                limit: BASELINE_ROWS,
                sortKey: "updated_at",
                archived,
                sourceKinds: [],
                modelProviders: [],
                cwd: [...group.scope],
                useStateDbOnly: true,
            }).then(page => page.data.map(thread => ({thread, archived})))));
            for (const row of await this.deps.rows(pages.flat())) {
                group.rows.set(row.sessionId, sessionIndexRowSignature(row));
            }
        });
    }

    private async flush(): Promise<void> {
        const now = this.now();
        const scan = this.scanRequested;
        this.scanRequested = false;
        this.firstStateChangeAt = null;
        this.scanDueAt = null;
        this.threadsDueAt = null;
        const requested = new Set(this.pendingThreads);
        this.pendingThreads.clear();
        const deleted = new Map(this.deletedThreads);
        this.deletedThreads.clear();
        const rowEntries = [...this.pendingEntries.values()];
        this.pendingEntries.clear();
        for (const [threadId, at] of this.lastChangeAt) {
            if (now - at >= this.timings.minChangeIntervalMs) this.lastChangeAt.delete(threadId);
        }

        const found = new Map<string, ThreadEntry>();
        await this.withReader(async (reader) => {
            if (scan) {
                for (const entry of await this.scan(reader)) found.set(entry.thread.id, entry);
                for (const threadId of this.nameLog?.readRenamedThreads() ?? []) requested.add(threadId);
            }
            const toRead = [...requested].filter(threadId => !found.has(threadId) && !deleted.has(threadId));
            for (let start = 0; start < toRead.length; start += READ_CONCURRENCY) {
                await Promise.all(toRead.slice(start, start + READ_CONCURRENCY).map(async (threadId) => {
                    const entry = await this.readThread(reader, threadId);
                    if (entry === "missing") {
                        deleted.set(threadId, false);
                    } else if (entry !== null) {
                        found.set(threadId, entry);
                    }
                }));
            }
        });
        for (const entry of rowEntries) {
            if (!found.has(entry.thread.id) && !deleted.has(entry.thread.id) && !requested.has(entry.thread.id)) {
                found.set(entry.thread.id, entry);
            }
        }
        if (this.disposed || this.subscriptions.size === 0) return;
        await Promise.all([...this.groups.values()].map(group => group.ready));

        const batches = new Map<Subscription, SessionListChanges>();
        const batchOf = (subscription: Subscription): SessionListChanges => {
            let batch = batches.get(subscription);
            if (batch === undefined) {
                batch = {subscriptionId: subscription.id, sessions: [], removed: []};
                batches.set(subscription, batch);
            }
            return batch;
        };

        const inScope = [...found.values()]
            .map(entry => ({entry, groups: this.groupsOf(entry.thread.cwd)}))
            .filter(({groups}) => groups.length > 0);
        const rows = inScope.length === 0 ? [] : await this.deps.rows(inScope.map(({entry}) => entry));
        for (const [index, {entry, groups}] of inScope.entries()) {
            const threadId = entry.thread.id;
            const row = rows[index]!;
            const signature = sessionIndexRowSignature(row);
            const behind: Subscription[] = [];
            for (const group of groups) {
                group.rows.set(threadId, signature);
                for (const subscription of group.subscriptions) {
                    if (subscription.sent.get(threadId) !== signature) behind.push(subscription);
                }
            }
            if (behind.length === 0) continue;
            const last = this.lastChangeAt.get(threadId);
            if (last !== undefined && now - last < this.timings.minChangeIntervalMs) {
                // Read again when the thread may go out: it can have changed once more by then.
                this.pendingThreads.add(threadId);
                const due = last + this.timings.minChangeIntervalMs;
                this.threadsDueAt = this.threadsDueAt === null ? due : Math.min(this.threadsDueAt, due);
                continue;
            }
            this.lastChangeAt.set(threadId, now);
            for (const subscription of behind) {
                subscription.sent.set(threadId, signature);
                batchOf(subscription).sessions.push(row);
            }
        }

        for (const [threadId, own] of deleted) {
            const knowing = [...this.subscriptions.values()]
                .filter(subscription => subscription.sent.has(threadId) || subscription.group.rows.has(threadId));
            // A thread that this adapter deleted but no group has seen can still be in a list that the client
            // read further down: its scope is unknown, so every subscription hears of it.
            const targets = knowing.length > 0 || !own ? knowing : [...this.subscriptions.values()];
            for (const group of this.groups.values()) group.rows.delete(threadId);
            for (const subscription of targets) {
                subscription.sent.delete(threadId);
                batchOf(subscription).removed.push(threadId);
            }
        }

        for (const batch of batches.values()) {
            if (this.disposed || !this.subscriptions.has(batch.subscriptionId)) continue;
            try {
                await this.deps.notify(batch);
            } catch (error) {
                logger.log("Failed to send session list changes", {subscriptionId: batch.subscriptionId, error: String(error)});
            }
        }
    }

    /**
     * The threads updated since the last scan, unarchived and archived, newest first, and moves the marks on.
     * Threads of the second of the mark are read again: `updatedAt` has seconds, so one of them can have changed
     * after the last scan. The first scan only sets the marks.
     */
    private async scan(reader: SessionListReader): Promise<ThreadEntry[]> {
        const generation = this.watchGeneration;
        const marks = this.marks;
        const sides = await Promise.all(([false, true] as const).map(async (archived) => {
            const mark = marks === null ? null : marks[archived ? "archived" : "unarchived"];
            const entries: ThreadEntry[] = [];
            let newest = mark ?? 0;
            let cursor: string | null = null;
            for (let page = 0; page < SCAN_MAX_PAGES; page++) {
                const response: ThreadListResponse = await reader.threadList({
                    cursor,
                    limit: page === 0 ? SCAN_FIRST_PAGE : SCAN_NEXT_PAGE,
                    sortKey: "updated_at",
                    archived,
                    sourceKinds: [],
                    modelProviders: [],
                    useStateDbOnly: true,
                });
                let reachedMark = false;
                for (const thread of response.data) {
                    if (mark !== null && thread.updatedAt < mark) {
                        reachedMark = true;
                        break;
                    }
                    entries.push({thread, archived});
                    newest = Math.max(newest, thread.updatedAt);
                }
                cursor = response.nextCursor;
                if (reachedMark || mark === null || cursor === null) break;
                if (page === SCAN_MAX_PAGES - 1) {
                    logger.log("The session list scan stops at its page limit", {archived, pages: SCAN_MAX_PAGES});
                }
            }
            return {entries, newest};
        }));
        // The last subscription ended meanwhile and reset the marks: this scan must not set them again.
        if (generation === this.watchGeneration) {
            this.marks = {unarchived: sides[0]!.newest, archived: sides[1]!.newest};
        }
        return marks === null ? [] : sides.flatMap(side => side.entries);
    }

    /** A thread by id, `"missing"` when Codex has none, `null` when the list does not show it or the read failed. */
    private async readThread(reader: SessionListReader, threadId: string): Promise<ThreadEntry | "missing" | null> {
        let thread: Thread;
        try {
            thread = (await reader.threadRead({threadId})).thread;
        } catch (error) {
            if (isMissingThreadError(error)) return "missing";
            logger.log("Session list subscription cannot read a thread", {threadId, error: String(error)});
            return null;
        }
        if (!isListedThread(thread)) return null;
        return {thread, archived: thread.path !== null && isArchivedRolloutPath(thread.path, this.deps.codexHome())};
    }

    /** The groups whose scope has the cwd. Resolves the worktrees again, now and then, for a cwd of none. */
    private groupsOf(cwd: string): Group[] {
        const groups = [...this.groups.values()].filter(group => group.scope.has(cwd));
        if (groups.length > 0 || this.now() - this.scopesRefreshedAt < SCOPE_REFRESH_MS) return groups;
        this.scopesRefreshedAt = this.now();
        for (const group of this.groups.values()) group.scope = new Set(this.deps.scopeCwds(group.cwd));
        return [...this.groups.values()].filter(group => group.scope.has(cwd));
    }
}

/** The sources that `thread/list` lists without `sourceKinds`: the CLI and the IDE extensions, as AIR. */
function isInteractiveSource(thread: Thread): boolean {
    return thread.source === "cli" || thread.source === "vscode";
}

/**
 * Whether `thread/list` lists a thread that `thread/read` returned: one that is not ephemeral, from an
 * interactive source, with a first user message, which is its `preview`.
 */
export function isListedThread(thread: Thread): boolean {
    return !thread.ephemeral && isInteractiveSource(thread) && thread.preview !== "" && thread.path !== null;
}
