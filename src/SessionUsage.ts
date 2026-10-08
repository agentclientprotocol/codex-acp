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
    readLastTokenTotal,
    scanSpawnedThreads,
    type RawTokens,
    type SessionUsageTokens,
    type SpawnScan,
    usageTokens,
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
/** The most threads whose rollouts are read at a time. */
const READ_CONCURRENCY = 8;

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
    forked: boolean;
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
    private readonly spawnScans = new Map<string, SpawnScan>();
    private readonly subagents = new Map<string, Subagent | null>();
    private readonly pending = new Map<string, UsageSubject>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private disposed = false;
    private readonly nowSeconds: () => number;

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
        if (!current || (cached.recheckAt !== null && this.nowSeconds() >= cached.recheckAt)) this.schedule(subject);
        return cached?.usage;
    }

    /** Drops the pending reads. */
    dispose(): void {
        this.disposed = true;
        this.pending.clear();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    /** Whether reads are pending or running. For tests. */
    busy(): boolean {
        return this.running || this.timer !== null;
    }

    private schedule(subject: UsageSubject): void {
        if (this.disposed) return;
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
                for (let start = 0; start < batch.length; start += READ_CONCURRENCY) {
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
    private async read({thread}: UsageSubject): Promise<boolean> {
        let usage: SessionUsage | null = null;
        if (thread.path !== null) {
            try {
                const own = await this.tokensOf(thread.id, thread.path, thread.forkedFromId !== null);
                if (own !== null) {
                    usage = {...own, model: thread.model, subagents: await this.subagentUsages(thread.id, thread.path)};
                }
            } catch (error) {
                // Read again when the thread is listed next.
                logger.log("Cannot read the token usage of a thread", {threadId: thread.id, error: String(error)});
                return false;
            }
        }
        const before = this.usages.get(thread.id);
        remember(this.usages, thread.id, {
            updatedAt: thread.updatedAt,
            path: thread.path,
            usage,
            recheckAt: this.recheckTime(thread),
        });
        return before === undefined ? usage !== null : JSON.stringify(before.usage) !== JSON.stringify(usage);
    }

    /** The usage of the subagents that a thread spawned and that have any, in the order they were spawned. */
    private async subagentUsages(threadId: string, file: string): Promise<SubagentUsage[]> {
        const scan = await scanSpawnedThreads(file, threadId, this.spawnScans.get(threadId) ?? null);
        remember(this.spawnScans, threadId, scan);
        const usages = await Promise.all(scan.threadIds.map(async (childId): Promise<SubagentUsage | null> => {
            let child = await this.subagent(childId);
            if (child === null) return null;
            let tokens: SessionUsageTokens | null;
            try {
                tokens = await this.tokensOf(childId, child.path, child.forked);
            } catch {
                // Archiving or unarchiving a thread moves its rollout: the thread knows where to.
                this.subagents.delete(childId);
                child = await this.subagent(childId);
                if (child === null) return null;
                tokens = await this.tokensOf(childId, child.path, child.forked);
            }
            return tokens === null ? null : {sessionId: childId, model: child.model, ...tokens};
        }));
        return usages.filter((usage): usage is SubagentUsage => usage !== null);
    }

    private async subagent(threadId: string): Promise<Subagent | null> {
        const known = this.subagents.get(threadId);
        if (known !== undefined) return known;
        const thread = await this.deps.readThread(threadId);
        const subagent = thread === null || thread.path === null
            ? null
            : {path: thread.path, model: thread.model, forked: thread.forkedFromId !== null};
        remember(this.subagents, threadId, subagent);
        return subagent;
    }

    /**
     * The own usage of a thread from its rollout, or `null` when it has no `token_count`. The rollout is read
     * again only when its path, size or modification time changed.
     */
    private async tokensOf(threadId: string, file: string, forked: boolean): Promise<SessionUsageTokens | null> {
        const stats = await fs.stat(file);
        const stamp = `${file}:${stats.size}:${stats.mtimeMs}`;
        const cached = this.fileTokens.get(threadId);
        if (cached !== undefined && cached.stamp === stamp) {
            remember(this.fileTokens, threadId, cached);
            return cached.tokens;
        }
        const tokens = await this.readTokens(threadId, file, forked);
        remember(this.fileTokens, threadId, {stamp, tokens});
        return tokens;
    }

    private async readTokens(threadId: string, file: string, forked: boolean): Promise<SessionUsageTokens | null> {
        const total = await readLastTokenTotal(file);
        if (total === null) return null;
        if (!forked) return usageTokens(total);
        let inherited = this.inherited.get(threadId);
        if (inherited === undefined) {
            const first = await readFirstTokenCount(file);
            inherited = first === null ? null : first.last === null ? first.total : minus(first.total, first.last);
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

/** Keeps a value, most recent last, and drops the oldest beyond {@link MAX_CACHED}. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
}
