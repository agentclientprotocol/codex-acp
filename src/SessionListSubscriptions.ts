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
    /** A row with the usage last read for its thread, see `SessionUsageIndex`. */
    withLatestUsage(row: acp.SessionInfo): acp.SessionInfo;
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
    /** The row last sent or read as the baseline for each thread of the scope that the group has seen. */
    rows: Map<string, GroupRow>;
    /** Resolves when the baseline rows are read. Never rejects. */
    ready: Promise<void>;
    baselined: boolean;
    /** The {@link SessionListSubscriptions.epoch} when the baseline was read: an older read does not count. */
    baselineEpoch: number;
    /** When {@link scope} was resolved. */
    scopeResolvedAt: number;
}

interface Subscription {
    id: string;
    group: Group;
    /** The signature of the row that the client has for each thread: the baseline, then what was sent. */
    sent: Map<string, string>;
    /** The baseline is in {@link sent}. */
    baselined: boolean;
    /** The client has the id: `subscribe` answered. Changes before that wait in {@link held}. */
    ready: boolean;
    held: SessionListChanges | null;
    readyTimer: ReturnType<typeof setTimeout> | null;
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
    /** Where a scan that stopped at its page limit goes on, per archive state. */
    private resumes: Record<"unarchived" | "archived", {cursor: string, cutoff: number, newest: number} | null> = {unarchived: null, archived: null};
    /** Moves on when the watching stops, so that a scan that was running then does not set the marks again. */
    private watchGeneration = 0;

    /** Threads to read with `thread/read` in the next flush. */
    private readonly pendingThreads = new Set<string>();
    /** Threads whose usage was read, with their cwd, see {@link usageRead}. */
    private readonly pendingUsage = new Map<string, string>();
    /**
     * Threads that groups whose worktrees were resolved too recently could not take: offered to them again when
     * they may resolve again.
     */
    private readonly scopeRetries = new Map<string, {entry: ThreadEntry, at: number}>();
    /** Counts reads and baselines, so that a read that started before a baseline does not override it. */
    private epoch = 0;
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
                baselined: false,
                baselineEpoch: 0,
                scopeResolvedAt: this.now(),
            };
            this.groups.set(key, created);
            group = created;
            this.startWatching();
            created.ready = this.readBaseline(created);
        }
        const subscription: Subscription = {id: randomUUID(), group, sent: new Map(), baselined: false, ready: false, held: null, readyTimer: null};
        this.subscriptions.set(subscription.id, subscription);
        group.subscriptions.add(subscription);
        // The client has what it listed: the rows the group knows now, or the baseline once it is read.
        if (group.baselined) this.takeBaseline(subscription);
        this.startWatching();
        await Promise.all([group.ready, this.marksReady]);
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

    private takeBaseline(subscription: Subscription): void {
        subscription.sent = new Map([...subscription.group.rows].map(([threadId, {signature}]) => [threadId, signature]));
        subscription.baselined = true;
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
            case "thread/tokenUsage/updated":
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
     * The usage of these threads was read: their rows, as last sent, get it. The rest of a row stays as it was,
     * since the thread that the usage was read for can be older than the row.
     */
    usageRead(threads: Array<{threadId: string, cwd: string}>): void {
        if (this.subscriptions.size === 0) return;
        for (const {threadId, cwd} of threads) this.pendingUsage.set(threadId, cwd);
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
        this.pendingUsage.clear();
        this.scopeRetries.clear();
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
        // The marks come first: a change after them is scanned, a change before them is in the baseline.
        await this.marksReady;
        // A read that starts after this one can be newer than the baseline; one that started before cannot.
        const epoch = ++this.epoch;
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
                group.rows.set(row.sessionId, {row, signature: sessionIndexRowSignature(row)});
            }
        });
        group.baselined = true;
        group.baselineEpoch = epoch;
        for (const subscription of group.subscriptions) {
            if (!subscription.baselined) this.takeBaseline(subscription);
        }
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
        this.pendingThreads.clear();
        const deleted = new Map(this.deletedThreads);
        this.deletedThreads.clear();
        const usageRead = new Map(this.pendingUsage);
        this.pendingUsage.clear();
        for (const [threadId, at] of this.lastChangeAt) {
            if (startedAt - at >= this.timings.minChangeIntervalMs) this.lastChangeAt.delete(threadId);
        }
        const readEpoch = ++this.epoch;

        // A scan before the first marks would only set them: it waits for them instead.
        if (scan) await this.marksReady;
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
        if (this.disposed || this.subscriptions.size === 0) return;
        await Promise.all([...this.groups.values()].map(group => group.ready));

        const batches = new Map<Subscription, SessionListChanges>();
        // A baseline read that started after these reads can be newer than they are: such a thread is read again.
        const inScope = [...found.values()].flatMap(entry => {
            const groups = this.groupsOf(entry.thread.cwd, entry);
            const current = groups.filter(group => group.baselineEpoch < readEpoch);
            if (current.length < groups.length) this.readAgain(entry.thread.id, this.now());
            return current.length === 0 ? [] : [{entry, groups: current}];
        });
        const rows = inScope.length === 0 ? [] : await this.deps.rows(inScope.map(({entry}) => entry));
        for (const [index, {entry, groups}] of inScope.entries()) {
            this.offer(entry.thread.id, groups.map(group => ({group, row: rows[index]!})), batches);
        }
        for (const [threadId, cwd] of usageRead) {
            if (found.has(threadId) || deleted.has(threadId)) continue;
            const offers: Array<{group: Group, row: acp.SessionInfo}> = [];
            let unknown = false;
            for (const group of this.groupsOf(cwd)) {
                const known = group.rows.get(threadId);
                if (known === undefined) unknown = true;
                else offers.push({group, row: this.deps.withLatestUsage(known.row)});
            }
            if (offers.length > 0) this.offer(threadId, offers, batches);
            // A group of the scope without a row of the thread, as for one from a later list page, gets it read
            // anew, which also tells whether it still is there.
            if (unknown) this.readAgain(threadId, this.now());
        }
        // The threads that groups could not take for their worktrees a moment ago.
        const retries = [...this.scopeRetries].filter(([threadId, {at}]) =>
            at <= this.now() && !found.has(threadId) && !deleted.has(threadId));
        for (const [threadId] of retries) this.scopeRetries.delete(threadId);
        const retried = retries.flatMap(([, {entry}]) => {
            const groups = this.groupsOf(entry.thread.cwd).filter(group => group.baselineEpoch < readEpoch);
            return groups.length === 0 ? [] : [{entry, groups}];
        });
        const retriedRows = retried.length === 0 ? [] : await this.deps.rows(retried.map(({entry}) => entry));
        for (const [index, {entry, groups}] of retried.entries()) {
            this.offer(entry.thread.id, groups.map(group => ({group, row: retriedRows[index]!})), batches);
        }
        for (const {at} of this.scopeRetries.values()) {
            this.threadsDueAt = this.threadsDueAt === null ? at : Math.min(this.threadsDueAt, at);
        }

        for (const threadId of deleted.keys()) {
            const knowing = [...this.subscriptions.values()]
                .filter(subscription => subscription.sent.has(threadId) || subscription.group.rows.has(threadId));
            const cwd = [...this.groups.values()].map(group => group.rows.get(threadId)?.row.cwd).find(known => known !== undefined);
            // Every subscription whose scope has the cwd of the thread, which can be in a list that its client read
            // further down. A deleted thread that no group has seen has an unknown scope: every subscription hears
            // of it.
            const targets = cwd === undefined
                ? (knowing.length > 0 ? knowing : [...this.subscriptions.values()])
                : [...new Set([...knowing, ...[...this.subscriptions.values()].filter(subscription => subscription.group.scope.has(cwd))])];
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

    private readAgain(threadId: string, at: number): void {
        this.pendingThreads.add(threadId);
        this.threadsDueAt = this.threadsDueAt === null ? at : Math.min(this.threadsDueAt, at);
    }

    /**
     * Puts the row of a thread into the batch of each subscription of its groups that has another row. A thread
     * that went out less than {@link SessionListSubscriptionTimings.minChangeIntervalMs} ago is read again then.
     */
    private offer(threadId: string, offers: Array<{group: Group, row: acp.SessionInfo}>, batches: Map<Subscription, SessionListChanges>): void {
        const behind: Array<{subscription: Subscription, row: acp.SessionInfo, signature: string}> = [];
        const signed = offers.map(({group, row}) => ({group, row, signature: sessionIndexRowSignature(row)}));
        for (const {group, row, signature} of signed) {
            for (const subscription of group.subscriptions) {
                if (subscription.baselined && subscription.sent.get(threadId) !== signature) behind.push({subscription, row, signature});
            }
        }
        // Only a notification that goes out counts for the second: a subscription that is not ready yet holds the
        // row, and a newer one replaces it there.
        const last = this.lastChangeAt.get(threadId);
        const throttled = last !== undefined && this.now() - last < this.timings.minChangeIntervalMs
            && behind.some(({subscription}) => subscription.ready);
        if (throttled) {
            // Read again when the thread may go out: it can have changed once more by then. The groups keep
            // the rows they had, so a subscription that starts meanwhile still gets this change.
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
    private async scan(reader: SessionListReader): Promise<ThreadEntry[]> {
        const generation = this.watchGeneration;
        const marks = this.marks;
        const sides = await Promise.all(([false, true] as const).map(async (archived) => {
            const key: "archived" | "unarchived" = archived ? "archived" : "unarchived";
            const resume = this.resumes[key];
            // A scan that stopped at its page limit goes on where it stopped, down to the mark it had then.
            const mark = resume?.cutoff ?? (marks === null ? null : marks[key]);
            const entries: ThreadEntry[] = [];
            let newest = resume?.newest ?? mark ?? 0;
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
                    logger.log("The session list scan goes on later from its page limit", {archived, pages: SCAN_MAX_PAGES});
                    stoppedAt = cursor;
                }
            }
            return {key, mark, newest, stoppedAt, entries, resumed: resume !== null};
        }));
        // The last subscription ended meanwhile and reset the marks: this scan must not set them again.
        if (generation !== this.watchGeneration) return [];
        const next = {unarchived: 0, archived: 0};
        let goOn = false;
        for (const side of sides) {
            if (side.stoppedAt !== null && side.mark !== null) {
                // The mark moves on only once the scan reached it: the rest goes on in the next scan.
                this.resumes[side.key] = {cursor: side.stoppedAt, cutoff: side.mark, newest: side.newest};
                next[side.key] = side.mark;
                goOn = true;
            } else {
                // A scan that went on from a page limit read no newer threads: the next one starts from the top.
                if (side.resumed) goOn = true;
                this.resumes[side.key] = null;
                next[side.key] = side.newest;
            }
        }
        this.marks = next;
        if (goOn) this.stateChanged();
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
        if (thread.ephemeral || !isInteractiveSource(thread)) {
            // A helper thread of the own app-server, which the list never shows: its notifications are skipped.
            this.ignore(threadId);
            return null;
        }
        if (!isListedThread(thread)) return null;
        return {thread, archived: thread.path !== null && isArchivedRolloutPath(thread.path, this.deps.codexHome())};
    }

    /** The groups whose scope has the cwd. The worktrees of a group are resolved again every 10 s at most. */
    private groupsOf(cwd: string, entry?: ThreadEntry): Group[] {
        const now = this.now();
        const resolve = (group: Group): void => {
            group.scopeResolvedAt = now;
            group.scope = new Set(this.deps.scopeCwds(group.cwd));
        };
        // Worktrees come and go: every group resolves them again now and then, also one that has the cwd.
        for (const group of this.groups.values()) {
            if (now - group.scopeResolvedAt >= SCOPE_REFRESH_MS) resolve(group);
        }
        // A group without the cwd can miss a new worktree: it resolves again, at most once a second.
        let retryAt: number | null = null;
        for (const group of this.groups.values()) {
            if (group.scope.has(cwd)) continue;
            if (now - group.scopeResolvedAt >= SCOPE_RETRY_MS) {
                resolve(group);
            } else {
                const at = group.scopeResolvedAt + SCOPE_RETRY_MS;
                retryAt = retryAt === null ? at : Math.min(retryAt, at);
            }
        }
        if (retryAt !== null && entry !== undefined) {
            this.scopeRetries.delete(entry.thread.id);
            this.scopeRetries.set(entry.thread.id, {entry, at: retryAt});
            if (this.scopeRetries.size > MAX_IGNORED_THREADS) this.scopeRetries.delete(this.scopeRetries.keys().next().value!);
            this.threadsDueAt = this.threadsDueAt === null ? retryAt : Math.min(this.threadsDueAt, retryAt);
        }
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
