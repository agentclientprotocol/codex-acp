/**
 * The thread that a Codex thread was forked from, for the `forkedFrom` field of its session list row.
 *
 * `thread/list` answers `forkedFromId: null` for every thread; `thread/read` without turns gives the fork parent.
 * The fork parent never changes, so a found parent is cached for the thread's lifetime. A `null` parent is not
 * final: Codex can answer from its state DB without the rollout, and then without the parent. Such a thread is
 * read again once it changes. A list never waits for the read: the threads are read in the background, and a fork
 * found there is reported, see {@link SessionForkOriginsDeps.onFound}.
 */

import type {Thread, ThreadReadParams, ThreadReadResponse} from "./app-server/v2";
import {isThreadNotMaterializedError} from "./CodexThreadErrors";
import {logger} from "./Logger";
import {isMissingThreadError} from "./SessionIndexMutations";

/** The app-server request that the fork origins need. */
export interface SessionForkOriginsReader {
    threadRead(params: ThreadReadParams): Promise<ThreadReadResponse>;
}

export interface SessionForkOriginsDeps {
    /** The app-server to read from, or `null` when none runs: then nothing is read. */
    reader(): SessionForkOriginsReader | null;
    /** These threads turned out to be forks: their rows get `forkedFrom` now. */
    onFound(threadIds: string[]): void;
}

/** The most threads whose answer is kept. An entry is a thread id and a parent id. */
const MAX_CACHED = 16_384;
/** The most `thread/read` requests at a time. */
const READ_CONCURRENCY = 8;

/**
 * A thread without a known fork parent as it was at `updatedAt`: Codex answered `null`, or could not read it yet.
 * It is read again once the thread changes.
 */
interface NoParent {
    updatedAt: number;
}

export class SessionForkOrigins {
    /** The fork parent of each thread, or the thread as it was when a read gave no parent. */
    private readonly origins = new Map<string, string | NoParent>();
    private readonly pending = new Map<string, Thread>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private disposed = false;

    constructor(private readonly deps: SessionForkOriginsDeps) {}

    /**
     * The fork parent of a thread: `Thread.forkedFromId` when Codex gives it, else the one `thread/read` gave,
     * `null` for no fork or before the read. A thread that is not read yet is read in the background.
     */
    originOf(thread: Thread): string | null {
        if (thread.forkedFromId) return thread.forkedFromId;
        const known = this.origins.get(thread.id);
        if (typeof known === "string") return known;
        // A thread without a rollout is not listed, and Codex has nothing to read for it yet.
        if (thread.path === null) return null;
        if (known === undefined || known.updatedAt !== thread.updatedAt) this.schedule(thread);
        return null;
    }

    /** This adapter forked `parentId` into `threadId`: the fork parent is known without a read. */
    remember(threadId: string, parentId: string): void {
        this.pending.delete(threadId);
        remember(this.origins, threadId, parentId);
    }

    /**
     * Another part of the adapter read the thread with `thread/read`. A fork parent there is the answer and replaces a
     * `null` one; a parent found this way is reported, as a background read reports it. A `null` parent counts as a
     * read of the thread as it is now.
     */
    readElsewhere(thread: Thread): void {
        if (thread.forkedFromId) {
            const found = typeof this.origins.get(thread.id) !== "string";
            this.remember(thread.id, thread.forkedFromId);
            if (found && !this.disposed) this.deps.onFound([thread.id]);
            return;
        }
        const pending = this.pending.get(thread.id);
        if (pending !== undefined && pending.updatedAt === thread.updatedAt) this.pending.delete(thread.id);
        this.keepNoParent(thread);
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

    private schedule(thread: Thread): void {
        if (this.disposed) return;
        this.pending.set(thread.id, thread);
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
                const found: string[] = [];
                for (let start = 0; start < batch.length && !this.disposed; start += READ_CONCURRENCY) {
                    await Promise.all(batch.slice(start, start + READ_CONCURRENCY).map(async (thread) => {
                        if (await this.read(thread)) found.push(thread.id);
                    }));
                }
                if (found.length > 0 && !this.disposed) this.deps.onFound(found);
            }
        } finally {
            this.running = false;
        }
    }

    /** Reads the fork parent of a thread with `thread/read`; true when it is a fork. */
    private async read(thread: Thread): Promise<boolean> {
        // A thread listed again while it was read waits for that read, which may have answered meanwhile.
        const known = this.origins.get(thread.id);
        if (typeof known === "string" || (known !== undefined && known.updatedAt >= thread.updatedAt)) return false;
        // Without an app-server, the thread is read when it is listed next.
        const reader = this.deps.reader();
        if (reader === null) return false;
        let parent: string | null;
        try {
            parent = (await reader.threadRead({threadId: thread.id, includeTurns: false})).thread.forkedFromId || null;
        } catch (error) {
            if (!isNotReadableYet(error)) {
                // Not cached: the thread is read again when it is listed next.
                logger.log("Cannot read the fork parent of a thread", {threadId: thread.id, error: String(error)});
                return false;
            }
            parent = null;
        }
        // A found parent is final: a later read does not take it back.
        if (typeof this.origins.get(thread.id) === "string") return false;
        if (parent === null) {
            this.keepNoParent(thread);
            return false;
        }
        remember(this.origins, thread.id, parent);
        return true;
    }

    /** Keeps that a read of the thread as it is gave no parent, unless a parent or a later such read is known. */
    private keepNoParent(thread: Thread): void {
        const known = this.origins.get(thread.id);
        if (typeof known === "string" || (known !== undefined && known.updatedAt > thread.updatedAt)) return;
        remember(this.origins, thread.id, {updatedAt: thread.updatedAt});
    }
}

/** Codex has no rollout of the thread yet, or does not know it yet. */
function isNotReadableYet(error: unknown): boolean {
    return isMissingThreadError(error) || isThreadNotMaterializedError(error);
}

/** Keeps a value, most recent last, and drops the oldest beyond {@link MAX_CACHED}. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size <= MAX_CACHED) return;
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
}
