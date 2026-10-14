/**
 * `_session/list/subscribe`: the rows of the session list of a cwd that changed, pushed to the client as
 * `_session/list/changes`. Best effort: the client also re-reads the list now and then.
 *
 * A subscription covers the threads of its cwd and of the same subdirectory in the primary checkout and each
 * linked worktree, from the interactive sources, archived or not. Subscriptions of one cwd share one group:
 * the rows last computed for its threads. Each subscription keeps the signature of the rows it was sent: the
 * first change of a thread goes out in full, a later one only when it differs in more than `updatedAt`.
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

/** How long a scan that failed waits before it is tried again. */
const SCAN_RETRY_MS = 1_000;
/** The rows that a scan reads first, and then per page. */
const SCAN_FIRST_PAGE = 20;
const SCAN_NEXT_PAGE = 100;
/** The most pages of one scan. Changes beyond them are not sent. */
const SCAN_MAX_PAGES = 10;
/** The most `thread/read` requests at a time. */
const READ_CONCURRENCY = 8;
/** The most helper threads remembered as not listed. */
const MAX_IGNORED_THREADS = 256;
/** The shortest time between two resolutions of the worktrees of the groups. */
const SCOPE_REFRESH_MS = 10_000;
/** The shortest time between two resolutions of a group for a cwd that no group has. */
const SCOPE_RETRY_MS = 1_000;

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

interface GroupRow {
    row: acp.SessionInfo;
    signature: string;
}

interface Group {
    cwd: string;
    scope: Set<string>;
    subscriptions: Set<Subscription>;
    /** The row last sent or computed for each thread of the scope that the group has seen. */
    rows: Map<string, GroupRow>;
    /** Resolves when the group is ready: when the first marks are read. Never rejects. */
    ready: Promise<void>;
    /** When {@link scope} was resolved. */
    scopeResolvedAt: number;
}

interface Subscription {
    id: string;
    group: Group;
    /** The signature of the row last sent for each thread: none at first, so the first change goes out in full. */
    sent: Map<string, string>;
    /** The client has the id: `subscribe` answered. Changes before that wait in {@link held}. */
    ready: boolean;
    held: SessionListChanges | null;
    readyTimer: ReturnType<typeof setTimeout> | null;
    /**
     * The second of `updatedAt` when the subscription started: a thread that a scan alone found, updated no later,
     * did not change since, unless the subscription has its row. `null` until it is ready.
     */
    startedSecond: number | null;
    /** The {@link SessionListSubscriptions.epoch} when it started: a read that began before is older than its client's list. */
    epoch: number;
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
    /** When the watching started, in the seconds of `updatedAt`: the mark of a scan without marks. */
    private watchingSince = 0;
    /** Counts WAL changes: one that came after a scan stopped at its page limit asks for a scan from the top. */
    private stateChanges = 0;
    /** Where a scan that stopped at its page limit goes on, per archive state. */
    private resumes: Record<"unarchived" | "archived", {cursor: string, cutoff: number, newest: number, changesAtStart: number} | null> = {unarchived: null, archived: null};
    /** Moves on when the watching stops, so that a scan that was running then does not set the marks again. */
    private watchGeneration = 0;

    /** Threads to read with `thread/read` in the next flush. */
    private readonly pendingThreads = new Set<string>();
    /** Threads read again after the second between changes that only a scan had found, see {@link offer}. */
    private readonly scanRetries = new Set<string>();
    /** Counts flushes and subscriptions, so that a read is not offered to a subscription that started after it. */
    private epoch = 0;
    /** The epoch of the reads of the flush that runs. */
    private readEpoch = 0;
    /** Counts the app-servers, see {@link refreshLoadedThreads}. */
    private appServerGeneration = 0;
    /** Deleted threads, with whether this adapter deleted them. */
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
    private disposed = false;

    constructor(private readonly deps: SessionListSubscriptionDeps) {
        this.timings = deps.timings ?? DEFAULT_SESSION_LIST_SUBSCRIPTION_TIMINGS;
        this.now = deps.now ?? Date.now;
    }

    /**
     * Starts a subscription of an absolute cwd. It reads no rows: it resolves once the marks of the scans are
     * read, and the first change of each thread after that goes out in full.
     *
     * @throws RequestError `invalidParams` with `data.reason: "too_many_subscriptions"` beyond
     *   {@link MAX_SESSION_LIST_SUBSCRIPTIONS}.
     */
    async subscribe(cwd: string): Promise<string> {
        const startedSecond = Math.floor(this.now() / 1000);
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
                scopeResolvedAt: this.now(),
            };
            this.groups.set(key, created);
            group = created;
            this.startWatching();
            created.ready = this.makeReady(created);
        }
        const subscription: Subscription = {id: randomUUID(), group, sent: new Map(), ready: false, held: null, readyTimer: null, startedSecond: null, epoch: ++this.epoch};
        this.subscriptions.set(subscription.id, subscription);
        group.subscriptions.add(subscription);
        this.startWatching();
        await Promise.all([group.ready, this.marksReady]);
        subscription.startedSecond = startedSecond;
        // Ready once the answer to `subscribe` is out, which happens before any timer; the next flush sends
        // what was held meanwhile.
        if (this.subscriptions.get(subscription.id) === subscription) {
            subscription.readyTimer = setTimeout(() => {
                subscription.readyTimer = null;
                subscription.ready = true;
                if (subscription.held !== null) this.requestThreads(0);
            }, 0);
            subscription.readyTimer.unref?.();
        }
        return subscription.id;
    }




    /** Ends a subscription. Idempotent: an unknown id changes nothing. */
    unsubscribe(subscriptionId: string): void {
        const subscription = this.subscriptions.get(subscriptionId);
        if (subscription === undefined) return;
        this.subscriptions.delete(subscriptionId);
        if (subscription.readyTimer !== null) clearTimeout(subscription.readyTimer);
        const group = subscription.group;
        group.subscriptions.delete(subscription);
        if (group.subscriptions.size === 0 && this.groups.get(group.cwd) === group) this.groups.delete(group.cwd);
        if (this.subscriptions.size === 0) this.stopWatching();
    }

    /** Ends every subscription: the connection is gone. */
    dispose(): void {
        this.disposed = true;
        for (const subscription of this.subscriptions.values()) {
            if (subscription.readyTimer !== null) clearTimeout(subscription.readyTimer);
        }
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
                if (!this.ignoredThreads.has(notification.params.threadId)) this.threadChanged(notification.params.threadId);
                return;
            case "item/started":
            case "item/completed":
                // Review mode shows in the row state.
                if ((notification.params.item.type === "enteredReviewMode" || notification.params.item.type === "exitedReviewMode")
                    && !this.ignoredThreads.has(notification.params.threadId)) {
                    this.threadChanged(notification.params.threadId);
                }
                return;
            default:
                return;
        }
    }

    /**
     * The app-server was replaced: every row with a `state`, which only threads loaded there have, is read again,
     * and so are the given threads.
     */
    refreshLoadedThreads(threadIds: string[]): void {
        this.appServerGeneration++;
        if (this.subscriptions.size === 0) return;
        const loaded = [...this.groups.values()].flatMap(group => [...group.rows]
            .filter(([, {row}]) => {
                const meta = row._meta as Record<string, any> | undefined;
                return meta?.["jetbrains"]?.["air"]?.["state"] !== undefined;
            })
            .map(([threadId]) => threadId));
        for (const threadId of new Set([...threadIds, ...loaded])) this.threadChanged(threadId);
        // Threads whose reads failed with the old app-server, or waited for a new one, are read now.
        if (this.pendingThreads.size > 0) this.requestThreads(this.timings.ownChangeDelayMs);
    }

    /**
     * These threads have more to show than their last rows did, as a fork parent read from the rollout: they are
     * read again, as for a change of their own. Without a subscription nothing is kept: a later list has them.
     */
    threadsChanged(threadIds: string[]): void {
        if (this.subscriptions.size === 0) return;
        for (const threadId of threadIds) {
            if (!this.ignoredThreads.has(threadId)) this.threadChanged(threadId);
        }
    }

    private threadChanged(threadId: string): void {
        // Named by a change of its own: no longer only a thread that a scan found.
        this.scanRetries.delete(threadId);
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
        this.stateChanges++;
        this.requestScan();
    }

    private requestScan(): void {
        if (this.subscriptions.size === 0) return;
        const now = this.now();
        this.scanRequested = true;
        this.firstStateChangeAt ??= now;
        this.scanDueAt = Math.min(now + this.timings.quietMs, this.firstStateChangeAt + this.timings.maxWaitMs);
        this.arm();
    }

    /** Asks for a scan at a given time, after one that failed. */
    private scanAt(at: number): void {
        if (this.subscriptions.size === 0) return;
        this.scanRequested = true;
        this.scanDueAt = this.scanDueAt === null ? at : Math.min(this.scanDueAt, at);
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
            this.watchingSince = Math.floor(this.now() / 1000);
            // Sets the marks; when it fails, the next scan reads from when the watching started.
            this.marksReady = this.withReader(async (reader) => {
                await this.scan(reader, true);
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
                // An archive or unarchive is a change of its own, not only a thread that a scan found.
                this.scanRetries.delete(threadId);
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
        this.resumes = {unarchived: null, archived: null};
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
        this.scanRetries.clear();
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

    /**
     * Makes a new group ready. It reads no rows: a subscription gets the first row of each thread that changes after
     * it started in full, and compares only the later ones. It waits for the marks, so a change after them is scanned.
     */
    private async makeReady(group: Group): Promise<void> {
        await this.marksReady;
    }

    private async flush(): Promise<void> {
        const startedAt = this.now();
        // A flush for own threads leaves a scan that is not due yet for later: the WAL keeps its quiet time.
        const scan = this.scanRequested && this.scanDueAt !== null && this.scanDueAt <= startedAt;
        if (scan) {
            this.scanRequested = false;
            this.firstStateChangeAt = null;
            this.scanDueAt = null;
        }
        this.threadsDueAt = null;
        const requested = new Set(this.pendingThreads);
        // Without an app-server, the threads wait for the next flush, which a restart brings.
        if (this.deps.reader() !== null) this.pendingThreads.clear();
        else requested.clear();
        const deleted = new Map(this.deletedThreads);
        this.deletedThreads.clear();
        for (const [threadId, at] of this.lastChangeAt) {
            if (startedAt - at >= this.timings.minChangeIntervalMs) this.lastChangeAt.delete(threadId);
        }
        const appServerGeneration = this.appServerGeneration;
        this.readEpoch = ++this.epoch;

        // A scan before the first marks would only set them: it waits for them instead.
        if (scan) await this.marksReady;
        const found = new Map<string, ThreadEntry>();
        const scanned = new Set<string>();
        // Threads that a scan found but the second between changes held back: still found by a scan.
        const scanRetried = new Set([...requested].filter(threadId => this.scanRetries.delete(threadId)));
        await this.withReader(async (reader) => {
            if (scan) {
                // The renames first: a scan that follows them reads their names, and a rename after it is read
                // with the next flush, as it writes the name log.
                for (const threadId of this.nameLog?.readRenamedThreads() ?? []) {
                    // A rename is a change of its own, not only a thread that a scan found.
                    requested.add(threadId);
                    scanRetried.delete(threadId);
                    this.scanRetries.delete(threadId);
                }
                try {
                    for (const entry of await this.scan(reader)) {
                        found.set(entry.thread.id, entry);
                        scanned.add(entry.thread.id);
                    }
                } catch (error) {
                    // The renames are read all the same; the scan is tried again a second later.
                    logger.log("Session list scan failed", {error: String(error)});
                    this.scanAt(this.now() + SCAN_RETRY_MS);
                }
            }
            const toRead = [...requested].filter(threadId => !found.has(threadId) && !deleted.has(threadId));
            for (let start = 0; start < toRead.length; start += READ_CONCURRENCY) {
                await Promise.all(toRead.slice(start, start + READ_CONCURRENCY).map(async (threadId) => {
                    const entry = await this.readThread(reader, threadId);
                    if (entry === "missing") {
                        deleted.set(threadId, false);
                    } else if (entry === "failed") {
                        // Kept for the next flush, as after a restart of the app-server; not polled. A scan retry
                        // stays one.
                        // A change named meanwhile stays a change of its own.
                        if (scanRetried.has(threadId) && !this.pendingThreads.has(threadId)) this.scanRetries.add(threadId);
                        this.pendingThreads.add(threadId);
                    } else if (entry !== null) {
                        found.set(threadId, entry);
                    }
                }));
            }
        });
        // Only a thread that the scan alone found: a notification or a rename is a change of its own.
        const onlyScanned = (threadId: string): boolean =>
            (scanned.has(threadId) && !requested.has(threadId)) || scanRetried.has(threadId);
        if (this.disposed || this.subscriptions.size === 0) return;
        await Promise.all([...this.groups.values()].map(group => group.ready));
        if (appServerGeneration !== this.appServerGeneration) {
            // Read from an app-server that is gone: its states no longer hold. Read again from the new one.
            for (const threadId of found.keys()) this.readAgainAsFound(threadId, onlyScanned(threadId));
            found.clear();
        }

        const batches = new Map<Subscription, SessionListChanges>();
        const inScope = [...found.values()].flatMap(entry => {
            const groups = this.groupsOf(entry.thread.cwd);
            if (groups.length === 0) return [];
            // A thread that a scan alone found and no subscription counts as changed is not made a row.
            if (onlyScanned(entry.thread.id) && groups.every(group => [...group.subscriptions]
                .every(subscription => !this.takesScanned(subscription, entry)))) {
                return [];
            }
            return [{entry, groups}];
        });
        const rows = inScope.length === 0 ? [] : await this.deps.rows(inScope.map(({entry}) => entry));
        if (appServerGeneration !== this.appServerGeneration) {
            // Replaced while the rows were made: read again from the new app-server.
            for (const {entry} of inScope) this.readAgainAsFound(entry.thread.id, onlyScanned(entry.thread.id));
            inScope.length = 0;
        }
        for (const [index, {entry, groups}] of inScope.entries()) {
            this.offer(entry.thread.id, groups.map(group => ({group, row: rows[index]!})), batches,
                onlyScanned(entry.thread.id) ? entry : undefined);
        }
        let resolvedForDeletions = false;
        for (const threadId of deleted.keys()) {
            const knowing = [...this.subscriptions.values()]
                .filter(subscription => subscription.sent.has(threadId) || subscription.group.rows.has(threadId));
            const cwd = [...this.groups.values()].map(group => group.rows.get(threadId)?.row.cwd).find(known => known !== undefined);
            // A deletion has no later change to wait for: the groups resolve their worktrees now, once a flush.
            if (cwd !== undefined && !resolvedForDeletions) {
                resolvedForDeletions = true;
                this.placeCwd("", true);
            }
            const covering = cwd === undefined ? [] : [...this.groups.values()].filter(group => group.scope.has(cwd));
            // Every subscription whose scope has the cwd of the thread, which can be in a list that its client read
            // further down. A deleted thread that no group has seen has an unknown scope: every subscription hears
            // of it.
            const targets = cwd === undefined
                ? (knowing.length > 0 ? knowing : [...this.subscriptions.values()])
                : [...new Set([...knowing, ...[...this.subscriptions.values()].filter(subscription => covering.includes(subscription.group))])];
            for (const group of this.groups.values()) group.rows.delete(threadId);
            for (const subscription of targets) {
                subscription.sent.delete(threadId);
                batchOf(batches, subscription).removed.push(threadId);
            }
        }

        // A batch joins the changes held for a subscription; a ready subscription gets them all in one
        // notification. Sends happen only here, one flush at a time.
        for (const [subscription, batch] of batches) {
            subscription.held = subscription.held === null ? batch : mergeChanges(subscription.held, batch);
        }
        const sent: SessionListChanges[] = [];
        for (const subscription of this.subscriptions.values()) {
            if (this.disposed || !subscription.ready || subscription.held === null) continue;
            const changes = subscription.held;
            subscription.held = null;
            await this.send(changes);
            sent.push(changes);
        }
        // The second between two changes of a thread counts from when the last notification with it went out.
        this.markSent(sent);
    }

    private markSent(batches: SessionListChanges[]): void {
        const now = this.now();
        for (const batch of batches) {
            for (const row of batch.sessions) this.lastChangeAt.set(row.sessionId, now);
        }
    }

    /** Reads a thread again now, as found by a scan alone when it was. */
    private readAgainAsFound(threadId: string, scanOnly: boolean): void {
        if (scanOnly && !this.pendingThreads.has(threadId)) this.scanRetries.add(threadId);
        this.readAgain(threadId, this.now());
    }

    private readAgain(threadId: string, at: number): void {
        this.pendingThreads.add(threadId);
        this.threadsDueAt = this.threadsDueAt === null ? at : Math.min(this.threadsDueAt, at);
    }

    /**
     * Puts the row of a thread into the batch of each subscription of its groups that has another row. A thread
     * that went out less than {@link SessionListSubscriptionTimings.minChangeIntervalMs} ago is read again then.
     */
    private offer(
        threadId: string,
        offers: Array<{group: Group, row: acp.SessionInfo}>,
        batches: Map<Subscription, SessionListChanges>,
        scanned?: ThreadEntry,
    ): void {
        const behind: Array<{subscription: Subscription, row: acp.SessionInfo, signature: string}> = [];
        const signed = offers.map(({group, row}) => ({group, row, signature: sessionIndexRowSignature(row)}));
        let stale = false;
        for (const {group, row, signature} of signed) {
            for (const subscription of group.subscriptions) {
                // Started after these reads: its client may have listed something newer; read again for it.
                if (subscription.epoch > this.readEpoch) {
                    stale = true;
                    continue;
                }
                const sent = subscription.sent.get(threadId);
                if (scanned !== undefined && !this.takesScanned(subscription, scanned)) continue;
                if (sent !== signature) behind.push({subscription, row, signature});
            }
        }
        if (stale) this.readAgainAsFound(threadId, scanned !== undefined);
        // Only a notification that goes out counts for the second: a subscription that is not ready yet holds the
        // row, and a newer one replaces it there.
        const last = this.lastChangeAt.get(threadId);
        const throttled = last !== undefined && this.now() - last < this.timings.minChangeIntervalMs
            && behind.some(({subscription}) => subscription.ready);
        if (throttled) {
            // Read again when the thread may go out: it can have changed once more by then. The groups keep
            // the rows they had, so a subscription that starts meanwhile still gets this change.
            // A change named meanwhile, queued while this flush read, stays a change of its own.
            if (scanned !== undefined && !this.pendingThreads.has(threadId)) this.scanRetries.add(threadId);
            this.readAgain(threadId, last + this.timings.minChangeIntervalMs);
        } else {
            for (const {group, row, signature} of signed) group.rows.set(threadId, {row, signature});
        }
        for (const {subscription, row, signature} of behind) {
            if (throttled && subscription.ready) continue;
            subscription.sent.set(threadId, signature);
            batchOf(batches, subscription).sessions.push(row);
        }
    }

    /**
     * A scan reads the threads of the second of its mark again: one of them that the subscription has no row of and
     * that was not updated since the subscription started did not change for it.
     */
    private takesScanned(subscription: Subscription, scanned: ThreadEntry): boolean {
        return subscription.sent.has(scanned.thread.id) || subscription.startedSecond === null
            || scanned.thread.updatedAt > subscription.startedSecond;
    }

    private async send(changes: SessionListChanges): Promise<void> {
        try {
            await this.deps.notify(changes);
        } catch (error) {
            logger.log("Failed to send session list changes", {subscriptionId: changes.subscriptionId, error: String(error)});
        }
    }

    /**
     * The threads updated since the last scan, unarchived and archived, newest first, and moves the marks on.
     * Threads of the second of the mark are read again: `updatedAt` has seconds, so one of them can have changed
     * after the last scan. The first scan only sets the marks.
     */
    /** @param first the read of the first marks: one page of each archive state, whose newest thread is the mark. */
    private async scan(reader: SessionListReader, first = false): Promise<ThreadEntry[]> {
        const generation = this.watchGeneration;
        // A change after this, while a scan stopped at its page limit goes on, asks for a scan from the top.
        const changesAtStart = this.stateChanges;
        const marks = this.marks;
        // Both reads settle before a failure counts, so a retry never runs beside a read still out.
        const settled = await Promise.allSettled(([false, true] as const).map(async (archived) => {
            const key: "archived" | "unarchived" = archived ? "archived" : "unarchived";
            const resume = this.resumes[key];
            // A scan that stopped at its page limit goes on where it stopped, down to the mark it had then.
            // Without marks yet, as when their first read failed, the threads updated since the watching started.
            const mark: number = resume?.cutoff ?? (marks === null ? this.watchingSince : marks[key]);
            const entries: ThreadEntry[] = [];
            let newest = resume?.newest ?? (marks === null ? 0 : mark);
            let cursor: string | null = resume?.cursor ?? null;
            let stoppedAt: string | null = null;
            for (let page = 0; page < SCAN_MAX_PAGES; page++) {
                const response: ThreadListResponse = await reader.threadList({
                    cursor,
                    limit: page === 0 && resume === null ? SCAN_FIRST_PAGE : SCAN_NEXT_PAGE,
                    sortKey: "updated_at",
                    archived,
                    sourceKinds: [],
                    modelProviders: [],
                    useStateDbOnly: true,
                });
                let reachedMark = false;
                for (const thread of response.data) {
                    if (thread.updatedAt < mark) {
                        // Without marks, the newest thread is the mark, older than the watching or not.
                        if (marks === null) newest = Math.max(newest, thread.updatedAt);
                        reachedMark = true;
                        break;
                    }
                    entries.push({thread, archived});
                    newest = Math.max(newest, thread.updatedAt);
                }
                cursor = response.nextCursor;
                if (first || reachedMark || cursor === null) break;
                if (page === SCAN_MAX_PAGES - 1) {
                    logger.log("The session list scan goes on later from its page limit", {archived, pages: SCAN_MAX_PAGES});
                    stoppedAt = cursor;
                }
            }
            return {key, mark, newest, stoppedAt, entries, resumed: resume?.changesAtStart ?? null};
        }));
        const failed = settled.find((side): side is PromiseRejectedResult => side.status === "rejected");
        if (failed !== undefined) throw failed.reason;
        const sides = settled.map(side => (side as Exclude<typeof side, PromiseRejectedResult>).value);
        // The last subscription ended meanwhile and reset the marks: this scan must not set them again.
        if (generation !== this.watchGeneration) return [];
        // The first marks are no later than the watching started: a change during the start is read by the next scan.
        if (first) for (const side of sides) side.newest = Math.min(side.newest, this.watchingSince);
        const next = {unarchived: 0, archived: 0};
        let goOn = false;
        for (const side of sides) {
            if (side.stoppedAt !== null) {
                // The mark moves on only once the scan reached it: the rest goes on in the next scan.
                this.resumes[side.key] = {cursor: side.stoppedAt, cutoff: side.mark, newest: side.newest, changesAtStart: side.resumed ?? changesAtStart};
                next[side.key] = side.mark;
                goOn = true;
            } else {
                // A scan that went on from a page limit read no threads changed meanwhile: when there were any,
                // the next one starts from the top.
                if (side.resumed !== null && this.stateChanges > side.resumed) goOn = true;
                this.resumes[side.key] = null;
                next[side.key] = side.newest;
            }
        }
        this.marks = next;
        if (goOn) this.requestScan();
        return sides.flatMap(side => side.entries);
    }

    /** A thread by id, `"missing"` when Codex has none, `null` when the list does not show it or the read failed. */
    private async readThread(reader: SessionListReader, threadId: string): Promise<ThreadEntry | "missing" | "failed" | null> {
        let thread: Thread;
        try {
            thread = (await reader.threadRead({threadId})).thread;
        } catch (error) {
            if (isMissingThreadError(error)) return "missing";
            logger.log("Session list subscription cannot read a thread", {threadId, error: String(error)});
            return "failed";
        }
        if (thread.ephemeral || !isInteractiveSource(thread)) {
            // A helper thread of the own app-server, which the list never shows: its notifications are skipped.
            this.ignore(threadId);
            return null;
        }
        if (!isListedThread(thread)) return null;
        return {thread, archived: thread.path !== null && isArchivedRolloutPath(thread.path, this.deps.codexHome())};
    }

    /** The groups whose scope has the cwd. The worktrees of a group are resolved again every 10 s at most. */
    /**
     * The groups whose scope has the cwd. Worktrees come and go: every group resolves them again every 10 s, also
     * one that has the cwd, and one without the cwd at most once a second, as it can miss a new worktree.
     */
    private groupsOf(cwd: string): Group[] {
        return this.placeCwd(cwd).groups;
    }

    /** {@link groupsOf}, and whether a group without the cwd could not resolve its worktrees yet. */
    private placeCwd(cwd: string, force = false): {groups: Group[], deferred: boolean} {
        const now = this.now();
        let deferred = false;
        for (const group of this.groups.values()) {
            const age = now - group.scopeResolvedAt;
            if (age >= SCOPE_REFRESH_MS || (!group.scope.has(cwd) && (force || age >= SCOPE_RETRY_MS))) {
                group.scopeResolvedAt = now;
                group.scope = new Set(this.deps.scopeCwds(group.cwd));
            } else if (!group.scope.has(cwd)) {
                deferred = true;
            }
        }
        return {groups: [...this.groups.values()].filter(group => group.scope.has(cwd)), deferred};
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

function batchOf(batches: Map<Subscription, SessionListChanges>, subscription: Subscription): SessionListChanges {
    let batch = batches.get(subscription);
    if (batch === undefined) {
        batch = {subscriptionId: subscription.id, sessions: [], removed: []};
        batches.set(subscription, batch);
    }
    return batch;
}

/** The changes of two batches of one subscription as one: the later row of a thread wins, and a removal ends it. */
function mergeChanges(earlier: SessionListChanges, later: SessionListChanges): SessionListChanges {
    const rows = new Map(earlier.sessions.map(row => [row.sessionId, row]));
    for (const threadId of later.removed) rows.delete(threadId);
    for (const row of later.sessions) rows.set(row.sessionId, row);
    const removed = new Set([...earlier.removed, ...later.removed].filter(threadId => !rows.has(threadId)));
    return {subscriptionId: earlier.subscriptionId, sessions: [...rows.values()], removed: [...removed]};
}
