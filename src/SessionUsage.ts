/**
 * The token usage of a thread for its session list row, `_meta.jetbrains.air.usage`.
 *
 * The usage of a thread is the total of the last `token_count` in its rollout. A fork starts with the total of
 * the history it inherited: the first record of a fork carries that total plus the usage of the fork's first
 * request (`last_token_usage`), so the inherited part is the first total minus that last usage, and it is
 * subtracted to count only the thread's own work. A subagent is a thread of its own and is listed apart, never
 * summed into its parent.
 *
 * Reading rollouts is too slow for a list to wait for, so the usage is read in the background: a row carries the
 * usage known for its thread, and a read that changes it is reported, see {@link SessionUsageIndexDeps.onRead}.
 */

import fs from "node:fs/promises";
import type {Thread} from "./app-server/v2";
import {logger} from "./Logger";
import {
    minus,
    readFirstTokenCount,
    readForkOrigin,
    readLastTokenTotal,
    scanSpawnedThreads,
    type RawTokens,
    type SessionUsageTokens,
    type SpawnScan,
    usageTokens,
    ZERO_TOKENS,
} from "./RolloutUsage";

export type {SessionUsageTokens} from "./RolloutUsage";

export interface SubagentUsage extends SessionUsageTokens {
    sessionId: string;
    model: string | null;
}

export interface SessionUsage extends SessionUsageTokens {
    model: string | null;
    subagents: SubagentUsage[];
}

/** A thread of the session list and whether it is archived. */
export interface UsageSubject {
    thread: Thread;
    archived: boolean;
}

export interface SessionUsageIndexDeps {
    /** The thread of a subagent, for its rollout path and model; `null` when Codex has none. */
    readThread(threadId: string): Promise<Thread | null>;
    /** The usage of these threads was read and differs from what {@link SessionUsageIndex.usageOf} gave before. */
    onRead(subjects: UsageSubject[]): void;
    nowSeconds?: () => number;
}

/** The most entries of each cache. */
const MAX_CACHED = 4096;
/** A thread updated this recently can get another record within the same second of `updatedAt`. */
const UNSETTLED_SECONDS = 2;
/** The most threads, and separately the most subagents, whose rollouts are read at a time. */
const READ_CONCURRENCY = 8;
/**
 * How much of a rollout one read scans for spawned subagents. A longer scan goes on in a later read, so a large
 * rollout that is scanned for the first time does not hold up the usage of the other threads.
 */
const SPAWN_SCAN_BYTES = 8 * 1024 * 1024;
/** How long a scan that stopped at {@link SPAWN_SCAN_BYTES} waits before it goes on. */
const SPAWN_SCAN_PAUSE_MS = 250;

interface CachedUsage {
    updatedAt: number;
    path: string | null;
    usage: SessionUsage | null;
    /** When the same `updatedAt` is read again, see {@link SessionUsageIndex.recheckTime}; `null` for never. */
    recheckAt: number | null;
}

interface CachedFileTokens {
    /** The path, size and modification time of the rollout when it was read. */
    stamp: string;
    tokens: SessionUsageTokens | null;
}

interface Subagent {
    path: string;
    model: string | null;
    /** The stamp of the rollout when the thread was read: a subagent whose rollout changed is read again. */
    stamp: string | null;
}

/** Runs at most `limit` tasks at a time. */
function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
    let running = 0;
    const waiting: Array<() => void> = [];
    return async <T>(task: () => Promise<T>): Promise<T> => {
        // A finished task hands its slot to the next waiting one, so a new caller cannot take it meanwhile.
        if (running >= limit) await new Promise<void>(resolve => waiting.push(resolve));
        else running++;
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next !== undefined) next();
            else running--;
        }
    };
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The usage of the threads of the session list, read in the background so that a list never waits for it.
 *
 * {@link usageOf} answers what is known for a thread and schedules a read when the thread changed since. A
 * thread whose `updatedAt` and rollout did not change since its last read costs nothing. The inherited total of
 * a fork is read once, and the rollout of a thread is scanned for spawned subagents only past the last scan.
 */
export class SessionUsageIndex {
    private readonly usages = new Map<string, CachedUsage>();
    private readonly fileTokens = new Map<string, CachedFileTokens>();
    private readonly inherited = new Map<string, RawTokens | null>();
    /**
     * The thread each listed thread was forked from, or `null` for no fork: `thread/list` leaves `forkedFromId` out.
     * Dropped with the usage of the thread, so a row does not lose its `forkedFrom` while its usage is current.
     */
    private readonly origins = new Map<string, string | null>();
    private readonly spawnScans = new Map<string, SpawnScan>();
    private readonly subagents = new Map<string, Subagent>();
    private readonly pending = new Map<string, UsageSubject>();
    /** Threads to read again later: a scan that stopped at its budget, or a read within a second of `updatedAt`. */
    private readonly later = new Map<string, {subject: UsageSubject, at: number}>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private laterTimer: ReturnType<typeof setTimeout> | null = null;
    private laterAt: number | null = null;
    private running = false;
    private disposed = false;
    private readonly nowSeconds: () => number;
    private readonly subagentReads = limiter(READ_CONCURRENCY);
    /** The newest thread that each thread was listed as: a later read uses it, not the one it was scheduled for. */
    private readonly latest = new Map<string, UsageSubject>();

    constructor(private readonly deps: SessionUsageIndexDeps) {
        this.nowSeconds = deps.nowSeconds ?? (() => Date.now() / 1000);
    }

    /**
     * The usage known for a thread: `null` when its rollout has none, `undefined` before its first read. A thread
     * that changed since its last read keeps the usage of that read until the new one is done.
     */
    usageOf(subject: UsageSubject): SessionUsage | null | undefined {
        const cached = this.usages.get(subject.thread.id);
        const current = cached !== undefined && cached.updatedAt === subject.thread.updatedAt
            && cached.path === subject.thread.path;
        remember(this.latest, subject.thread.id, subject);
        if (!current || (cached.recheckAt !== null && this.nowSeconds() >= cached.recheckAt)) this.schedule(subject);
        // The model is the thread's latest, which can change without a new token count.
        return cached?.usage ? {...cached.usage, model: subject.thread.model} : cached?.usage;
    }

    /** The thread that a thread was forked from, `null` for no fork, `undefined` before its rollout was read. */
    forkOrigin(threadId: string): string | null | undefined {
        return this.origins.get(threadId);
    }

    /** The usage of the last read of a thread, whatever thread it was read for; `undefined` before any. */
    latestUsage(threadId: string): SessionUsage | null | undefined {
        return this.usages.get(threadId)?.usage;
    }

    /** Drops the pending reads. */
    dispose(): void {
        this.disposed = true;
        this.pending.clear();
        this.later.clear();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.laterTimer !== null) clearTimeout(this.laterTimer);
        this.laterTimer = null;
        this.laterAt = null;
    }

    /** Whether reads are pending or running, not counting the ones for later. For tests. */
    busy(): boolean {
        return this.running || this.timer !== null;
    }

    /** Reads the thread again after `delayMs`, unless it is read before for another reason. */
    private readLater(subject: UsageSubject, delayMs: number): void {
        if (this.disposed) return;
        const at = Date.now() + delayMs;
        const known = this.later.get(subject.thread.id);
        this.later.set(subject.thread.id, {subject, at: known === undefined ? at : Math.min(known.at, at)});
        this.armLater();
    }

    private armLater(): void {
        let next: number | null = null;
        for (const entry of this.later.values()) next = next === null ? entry.at : Math.min(next, entry.at);
        if (next === this.laterAt) return;
        if (this.laterTimer !== null) clearTimeout(this.laterTimer);
        this.laterTimer = null;
        this.laterAt = next;
        if (next === null || this.disposed) return;
        this.laterTimer = setTimeout(() => {
            this.laterTimer = null;
            this.laterAt = null;
            const now = Date.now();
            for (const [threadId, entry] of this.later) {
                if (entry.at > now) continue;
                this.later.delete(threadId);
                this.schedule(entry.subject);
            }
            this.armLater();
        }, Math.max(0, next - Date.now()));
        this.laterTimer.unref?.();
    }

    private schedule(scheduled: UsageSubject): void {
        if (this.disposed) return;
        const subject = this.latest.get(scheduled.thread.id) ?? scheduled;
        if (this.later.delete(subject.thread.id)) this.armLater();
        this.pending.set(subject.thread.id, subject);
        if (this.timer !== null || this.running) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.readPending();
        }, 0);
        this.timer.unref?.();
    }

    private async readPending(): Promise<void> {
        this.running = true;
        try {
            while (this.pending.size > 0 && !this.disposed) {
                const batch = [...this.pending.values()];
                this.pending.clear();
                const changed: UsageSubject[] = [];
                for (let start = 0; start < batch.length && !this.disposed; start += READ_CONCURRENCY) {
                    await Promise.all(batch.slice(start, start + READ_CONCURRENCY).map(async (subject) => {
                        if (await this.read(subject)) changed.push(subject);
                    }));
                }
                if (changed.length > 0 && !this.disposed) this.deps.onRead(changed);
            }
        } catch (error) {
            logger.log("Cannot read the token usage of the session list", {error: String(error)});
        } finally {
            this.running = false;
        }
    }

    /** Reads the usage of a thread; true when it differs from the usage known before. */
    private async read(subject: UsageSubject): Promise<boolean> {
        const {thread} = subject;
        // Whether a record can still come within the second of `updatedAt` is up to when the rollout is read,
        // not when the subagents are done.
        const recheckAt = this.recheckTime(thread);
        let usage: SessionUsage | null = null;
        let originRead = false;
        if (thread.path !== null) {
            try {
                if (!this.origins.has(thread.id)) {
                    const origin = await readForkOrigin(thread.path);
                    if (origin !== undefined) {
                        this.origins.set(thread.id, origin);
                        originRead = origin !== null;
                    }
                }
                const own = await this.tokensOf(thread.id, thread.path);
                if (own !== null) {
                    usage = {...own, model: thread.model, subagents: await this.subagentUsages(subject, thread.path)};
                }
            } catch (error) {
                // Read again when the thread is listed next.
                logger.log("Cannot read the token usage of a thread", {threadId: thread.id, error: String(error)});
                return false;
            }
        }
        const before = this.usages.get(thread.id);
        const evicted = remember(this.usages, thread.id, {updatedAt: thread.updatedAt, path: thread.path, usage, recheckAt});
        // The fork origin of a row lives as long as its usage.
        if (evicted !== undefined) this.origins.delete(evicted);
        // Another record can come within the second of `updatedAt` without moving it: read once more after it.
        if (recheckAt !== null) this.readLater(subject, Math.max(0, recheckAt - this.nowSeconds()) * 1000);
        return originRead || (before === undefined ? usage !== null : JSON.stringify(before.usage) !== JSON.stringify(usage));
    }

    /**
     * The usage of the subagents that a thread spawned and that have any, in the order they were spawned. A scan
     * that stops at its budget goes on later, and the usage grows by the subagents it finds.
     */
    private async subagentUsages(subject: UsageSubject, file: string): Promise<SubagentUsage[]> {
        const threadId = subject.thread.id;
        const scan = await scanSpawnedThreads(file, threadId, this.spawnScans.get(threadId) ?? null, SPAWN_SCAN_BYTES);
        remember(this.spawnScans, threadId, scan);
        if (!scan.done) this.readLater(subject, SPAWN_SCAN_PAUSE_MS);
        // A read that waits for its turn after the connection closed does nothing.
        const usages = await Promise.all(scan.threadIds.map(childId => this.subagentReads(
            async () => this.disposed ? null : await this.subagentUsage(childId),
        )));
        return usages.filter((usage): usage is SubagentUsage => usage !== null);
    }

    /** The usage of one subagent, or `null` when Codex has no rollout of it, or one without a token count. */
    private async subagentUsage(childId: string): Promise<SubagentUsage | null> {
        let child = this.subagents.get(childId) ?? await this.readSubagent(childId);
        if (child === null) return null;
        let stamp: string;
        try {
            stamp = await stampOf(child.path);
        } catch (error) {
            if (!isMissingFile(error)) throw error;
            // Archiving or unarchiving a thread moves its rollout: the thread knows where to.
            child = await this.readSubagent(childId);
            if (child === null) return null;
            try {
                stamp = await stampOf(child.path);
            } catch (again) {
                // Codex writes the rollout of a new thread later.
                if (isMissingFile(again)) return null;
                throw again;
            }
        }
        if (child.stamp !== null && child.stamp !== stamp) {
            // The subagent changed since it was read, and so may its model.
            child = await this.readSubagent(childId);
            if (child === null) return null;
        }
        if (child.stamp === null) {
            child = {...child, stamp};
            remember(this.subagents, childId, child);
        }
        const tokens = await this.tokensOf(childId, child.path);
        return tokens === null ? null : {sessionId: childId, model: child.model, ...tokens};
    }

    /** A subagent as Codex has it now. One without a rollout is not kept: it gets one later. */
    private async readSubagent(threadId: string): Promise<Subagent | null> {
        const thread = await this.deps.readThread(threadId);
        if (thread === null || thread.path === null) {
            this.subagents.delete(threadId);
            return null;
        }
        const subagent: Subagent = {path: thread.path, model: thread.model, stamp: null};
        remember(this.subagents, threadId, subagent);
        return subagent;
    }

    /**
     * The own usage of a thread from its rollout, or `null` when it has no `token_count`. The rollout is read
     * again only when its path, size or modification time changed.
     */
    private async tokensOf(threadId: string, file: string): Promise<SessionUsageTokens | null> {
        const stamp = await stampOf(file);
        const cached = this.fileTokens.get(threadId);
        if (cached !== undefined && cached.stamp === stamp) {
            remember(this.fileTokens, threadId, cached);
            return cached.tokens;
        }
        const tokens = await this.readTokens(threadId, file);
        remember(this.fileTokens, threadId, {stamp, tokens});
        return tokens;
    }

    private async readTokens(threadId: string, file: string): Promise<SessionUsageTokens | null> {
        const total = await readLastTokenTotal(file);
        if (total === null) return null;
        let inherited = this.inherited.get(threadId);
        if (inherited === undefined) {
            // A fork tells from its own session_meta: `thread/list` leaves out `Thread.forkedFromId`.
            let origin = this.origins.get(threadId);
            if (origin === undefined) {
                const read = await readForkOrigin(file);
                if (read === undefined) return null;
                origin = read;
            }
            const first = origin === null ? null : await readFirstTokenCount(file);
            inherited = origin === null
                ? ZERO_TOKENS
                : first === null ? null : first.last === null ? first.total : minus(first.total, first.last);
            remember(this.inherited, threadId, inherited);
        }
        // A fork whose first record is beyond the read start of its rollout: its own part is unknown.
        if (inherited === null) return null;
        return usageTokens(minus(total, inherited));
    }

    /**
     * `updatedAt` has seconds: a thread read within {@link UNSETTLED_SECONDS} of it can get another record without
     * a new `updatedAt`, so it is read again when it is listed after that time.
     */
    private recheckTime(thread: Thread): number | null {
        const settledAt = thread.updatedAt + UNSETTLED_SECONDS;
        return this.nowSeconds() < settledAt ? settledAt : null;
    }
}

/** What tells a rollout that changed: its path, size and modification time. */
async function stampOf(file: string): Promise<string> {
    const stats = await fs.stat(file);
    return `${file}:${stats.size}:${stats.mtimeMs}`;
}

/** Keeps a value, most recent last, and drops the oldest beyond {@link MAX_CACHED}; returns the dropped key. */
function remember<T>(cache: Map<string, T>, key: string, value: T): string | undefined {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size <= MAX_CACHED) return undefined;
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    return oldest;
}
