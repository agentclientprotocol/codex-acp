/**
 * The thread that a Codex thread was forked from, for the `forkedFrom` field of its session list row.
 *
 * `thread/list` answers `forkedFromId: null` for every thread; the fork parent is in the first line of the
 * thread's rollout, `session_meta`, as `payload.forked_from_id`. That line never changes once it is written, so
 * the answer is cached for the thread's lifetime, a fork or not. A list never waits for the read: the rollouts are
 * read in the background, and a fork found there is reported, see {@link SessionForkOriginsDeps.onFound}.
 */

import fs from "node:fs/promises";
import type {Thread} from "./app-server/v2";
import {logger} from "./Logger";

export interface SessionForkOriginsDeps {
    /** These threads turned out to be forks: their rows get `forkedFrom` now. */
    onFound(threadIds: string[]): void;
}

/** How much of the start of a rollout is read for its first line, and in what steps. */
const FIRST_LINE_LIMIT = 1024 * 1024;
const FIRST_LINE_STEP = 64 * 1024;
/** The most threads whose answer is kept. An entry is a thread id and a parent id. */
const MAX_CACHED = 16_384;
/** The most rollouts read at a time. */
const READ_CONCURRENCY = 8;
const NEWLINE = 0x0a;

/** A rollout whose first line was not complete or not there: read again once the thread changes. */
interface Unknown {
    path: string;
    updatedAt: number;
}

export class SessionForkOrigins {
    /** The fork parent of each thread, `null` for no fork, or the thread as it was when its first line was missing. */
    private readonly origins = new Map<string, string | null | Unknown>();
    private readonly pending = new Map<string, Thread>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private disposed = false;

    constructor(private readonly deps: SessionForkOriginsDeps) {}

    /**
     * The fork parent of a thread: `Thread.forkedFromId` when Codex gives it, else the one read from the rollout,
     * `null` for no fork or before the rollout was read. A thread that is not read yet is read in the background.
     */
    originOf(thread: Thread): string | null {
        if (thread.forkedFromId) return thread.forkedFromId;
        const known = this.origins.get(thread.id);
        if (typeof known === "string" || known === null) return known;
        if (thread.path === null) return null;
        if (known === undefined || known.path !== thread.path || known.updatedAt !== thread.updatedAt) this.schedule(thread);
        return null;
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

    /** Reads the fork parent of a thread from its rollout; true when it is a fork. */
    private async read(thread: Thread): Promise<boolean> {
        // A thread listed again while it was read waits for that read, which may have answered meanwhile.
        if (thread.path === null || isAnswer(this.origins.get(thread.id))) return false;
        let origin: string | null | undefined;
        try {
            origin = await readForkOrigin(thread.path);
        } catch (error) {
            // Not cached: the thread is read again when it is listed next.
            logger.log("Cannot read the fork parent of a thread", {threadId: thread.id, error: String(error)});
            return false;
        }
        // An answer is final: a later read of a moved or cut rollout does not take it back.
        if (isAnswer(this.origins.get(thread.id))) return false;
        remember(this.origins, thread.id, origin === undefined ? {path: thread.path, updatedAt: thread.updatedAt} : origin);
        return typeof origin === "string";
    }
}

/**
 * The thread that a rollout was forked from: `payload.forked_from_id` of its first line, `session_meta`, or `null`
 * for a rollout that is no fork. `undefined` while the first line is not complete, or longer than
 * {@link FIRST_LINE_LIMIT}.
 */
export async function readForkOrigin(file: string): Promise<string | null | undefined> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(file, "r");
    } catch (error) {
        // Codex writes the rollout of a new thread later.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    let firstLine: string | null = null;
    try {
        const chunks: Buffer[] = [];
        for (let position = 0; position < FIRST_LINE_LIMIT;) {
            const chunk = Buffer.alloc(FIRST_LINE_STEP);
            const {bytesRead} = await handle.read(chunk, 0, FIRST_LINE_STEP, position);
            if (bytesRead === 0) break;
            const end = chunk.subarray(0, bytesRead).indexOf(NEWLINE);
            chunks.push(chunk.subarray(0, end < 0 ? bytesRead : end));
            if (end >= 0) {
                firstLine = Buffer.concat(chunks).toString("utf8");
                break;
            }
            position += bytesRead;
        }
    } finally {
        await handle.close();
    }
    if (firstLine === null) return undefined;
    let meta: unknown;
    try {
        meta = JSON.parse(firstLine);
    } catch {
        return null;
    }
    const forkedFrom = field(field(meta, "payload"), "forked_from_id");
    return field(meta, "type") === "session_meta" && typeof forkedFrom === "string" && forkedFrom !== "" ? forkedFrom : null;
}

/** A fork parent or `null` for no fork, as opposed to a rollout that could not tell yet. */
function isAnswer(value: string | null | Unknown | undefined): value is string | null {
    return typeof value === "string" || value === null;
}

function field(value: unknown, key: string): unknown {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** Keeps a value, most recent last, and drops the oldest beyond {@link MAX_CACHED}. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size <= MAX_CACHED) return;
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
}
