/**
 * Reads the token usage and the spawned subagents of a thread from its rollout file.
 *
 * Codex writes `event_msg` `token_count` records into the rollout of a thread; `info.total_token_usage` of the
 * last one is the running total of the thread, `info.last_token_usage` the usage of the request it follows.
 * A thread that spawns a subagent records an item that names the child: `SubAgentActivity` with its
 * `agent_thread_id`, or, in older rollouts, a `spawn_agent` `CollabAgentToolCall` with its `receiver_thread_ids`.
 */

import fs from "node:fs/promises";

export interface SessionUsageTokens {
    /** Fresh input: neither read from nor written to the prompt cache. */
    inputTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
    /** Output, reasoning included. */
    outputTokens: number;
    reasoningTokens: number;
}

/** The fields of a Codex `token_count` total, as the rollout writes them. */
export interface RawTokens {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
}

/**
 * The tail windows read in turn for the last `token_count`. In real rollouts the last record is within 16 KB of
 * the end for 98% of threads and within 1 MB for all.
 */
const TAIL_WINDOWS = [16 * 1024, 128 * 1024, 1024 * 1024];
/** How much of the start of a fork's rollout is read for its first `token_count`, and in what chunks. */
const HEAD_LIMIT = 8 * 1024 * 1024;
const HEAD_CHUNK = 256 * 1024;

const TOKEN_COUNT_MARKER = "\"token_count\"";
const TOKEN_COUNT_BYTES = Buffer.from(TOKEN_COUNT_MARKER);
const NEWLINE = 0x0a;
/** How far into a `token_count` line its marker can be. */
const MAX_TOKEN_COUNT_PREFIX = 4096;

/** The `token_count` total and last usage of a rollout line, or `null` for any other line. */
function tokenCountOf(line: string): {total: RawTokens, last: RawTokens | null} | null {
    if (!line.includes(TOKEN_COUNT_MARKER)) return null;
    let record: unknown;
    try {
        record = JSON.parse(line);
    } catch {
        return null;
    }
    const payload = field(record, "payload");
    if (field(record, "type") !== "event_msg" || field(payload, "type") !== "token_count") return null;
    const info = field(payload, "info");
    const total = rawTokens(field(info, "total_token_usage"));
    return total === null ? null : {total, last: rawTokens(field(info, "last_token_usage"))};
}

function rawTokens(value: unknown): RawTokens | null {
    const count = (key: string): number | null => {
        const number = field(value, key);
        return typeof number === "number" && Number.isFinite(number) ? number : null;
    };
    const input = count("input_tokens");
    const output = count("output_tokens");
    if (input === null || output === null) return null;
    return {
        input,
        cached: count("cached_input_tokens") ?? 0,
        cacheWrite: count("cache_write_input_tokens") ?? 0,
        output,
        reasoning: count("reasoning_output_tokens") ?? 0,
    };
}

function field(value: unknown, key: string): unknown {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function minus(left: RawTokens, right: RawTokens): RawTokens {
    return {
        input: Math.max(0, left.input - right.input),
        cached: Math.max(0, left.cached - right.cached),
        cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
        output: Math.max(0, left.output - right.output),
        reasoning: Math.max(0, left.reasoning - right.reasoning),
    };
}

/** The usage fields of a total. Fresh input leaves out cache reads and writes, as `toTokenCount` does. */
export function usageTokens(tokens: RawTokens): SessionUsageTokens {
    return {
        inputTokens: Math.max(0, tokens.input - tokens.cached - tokens.cacheWrite),
        cachedReadTokens: tokens.cached,
        cachedWriteTokens: tokens.cacheWrite,
        outputTokens: tokens.output,
        reasoningTokens: tokens.reasoning,
    };
}

/** The total of the last `token_count` in the rollout, read from its end in growing windows. */
export async function readLastTokenTotal(file: string): Promise<RawTokens | null> {
    const handle = await fs.open(file, "r");
    try {
        const size = (await handle.stat()).size;
        for (const window of TAIL_WINDOWS) {
            const start = Math.max(0, size - window);
            const buffer = Buffer.alloc(size - start);
            await handle.read(buffer, 0, buffer.length, start);
            let end = buffer.length;
            while (end > 0) {
                const marker = buffer.lastIndexOf(TOKEN_COUNT_BYTES, end - 1);
                if (marker < 0) break;
                const lineStart = buffer.lastIndexOf(NEWLINE, marker) + 1;
                // A line cut by the window start is read whole with the next window.
                if (lineStart === 0 && start > 0) break;
                const lineEnd = buffer.indexOf(NEWLINE, marker);
                const count = tokenCountOf(buffer.toString("utf8", lineStart, lineEnd < 0 ? buffer.length : lineEnd));
                if (count !== null) return count.total;
                end = lineStart;
            }
            if (start === 0) break;
        }
        return null;
    } finally {
        await handle.close();
    }
}

export const ZERO_TOKENS: Readonly<RawTokens> = Object.freeze({input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0});

/** How much of the start of a rollout is read for its `session_meta` line, and in what steps. */
const SESSION_META_LIMIT = 4 * 1024 * 1024;
const SESSION_META_STEP = 64 * 1024;

/**
 * The thread that a rollout was forked from: `forked_from_id` of its `session_meta`, the first line, or `null`
 * for a rollout that is no fork. `undefined` while that line is not complete yet.
 */
export async function readForkOrigin(file: string): Promise<string | null | undefined> {
    const handle = await fs.open(file, "r");
    let firstLine: string | null = null;
    try {
        const chunks: Buffer[] = [];
        for (let position = 0; position < SESSION_META_LIMIT;) {
            const chunk = Buffer.alloc(SESSION_META_STEP);
            const {bytesRead} = await handle.read(chunk, 0, SESSION_META_STEP, position);
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

/** The first `token_count` of the rollout, read from its start, or `null` within {@link HEAD_LIMIT}. */
export async function readFirstTokenCount(file: string): Promise<{total: RawTokens, last: RawTokens | null} | null> {
    const handle = await fs.open(file, "r");
    try {
        let pending = Buffer.alloc(0);
        // Inside a long line that is no `token_count`: its rest is skipped.
        let skipping = false;
        let position = 0;
        while (position < HEAD_LIMIT) {
            const chunk = Buffer.alloc(HEAD_CHUNK);
            const {bytesRead} = await handle.read(chunk, 0, HEAD_CHUNK, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            let fresh = chunk.subarray(0, bytesRead);
            if (skipping) {
                const lineEnd = fresh.indexOf(NEWLINE);
                if (lineEnd < 0) continue;
                fresh = fresh.subarray(lineEnd + 1);
                skipping = false;
            }
            const buffer = pending.length === 0 ? fresh : Buffer.concat([pending, fresh]);
            let from = 0;
            for (;;) {
                const marker = buffer.indexOf(TOKEN_COUNT_BYTES, from);
                if (marker < 0) break;
                const lineEnd = buffer.indexOf(NEWLINE, marker);
                if (lineEnd < 0) break;
                const lineStart = buffer.lastIndexOf(NEWLINE, marker) + 1;
                const count = tokenCountOf(buffer.toString("utf8", lineStart, lineEnd));
                if (count !== null) return count;
                from = lineEnd + 1;
            }
            // The last line goes on in the next chunk. The marker is near the start of a `token_count` line,
            // which is a few KB long, so a longer line without it is none.
            pending = buffer.subarray(buffer.lastIndexOf(NEWLINE) + 1);
            if (pending.length > MAX_TOKEN_COUNT_PREFIX && pending.indexOf(TOKEN_COUNT_BYTES) < 0) {
                pending = Buffer.alloc(0);
                skipping = true;
            }
        }
        return tokenCountOf(pending.toString("utf8"));
    } finally {
        await handle.close();
    }
}

/** Markers of the records that name a spawned thread: a `SubAgentActivity` item and a `spawn_agent` tool call. */
const SPAWN_MARKERS = [Buffer.from("\"SubAgentActivity\""), Buffer.from("\"spawn_agent\"")];
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCAN_CHUNK = 1024 * 1024;

/** Where a scan of a rollout for spawned threads stopped, and what it found. */
export interface SpawnScan {
    /** The end of the last complete line read. */
    offset: number;
    /** The spawned thread ids, in the order of their first record. */
    threadIds: string[];
    /** The scan reached the end of the file, but for a last line without its newline. */
    done: boolean;
}

/**
 * The threads that a thread spawned, from its own records: an `item` of type `SubAgentActivity` with kind
 * `started` under the thread's `thread_id`, or of type `CollabAgentToolCall` with tool `spawn_agent` and the
 * thread as `sender_thread_id`. A rollout only grows, so a scan goes on from where the last one stopped, and
 * reads at most `maxBytes`; one of a file that is shorter now starts over.
 */
export async function scanSpawnedThreads(
    file: string,
    threadId: string,
    previous: SpawnScan | null,
    maxBytes: number,
): Promise<SpawnScan> {
    const handle = await fs.open(file, "r");
    try {
        const size = (await handle.stat()).size;
        const scan: SpawnScan = previous !== null && previous.offset <= size
            ? {offset: previous.offset, threadIds: [...previous.threadIds], done: false}
            : {offset: 0, threadIds: [], done: false};
        const seen = new Set(scan.threadIds);
        const limit = Math.min(size, scan.offset + maxBytes);
        let position = scan.offset;
        while (position < limit) {
            const length = Math.min(SCAN_CHUNK, size - position);
            const buffer = Buffer.alloc(length);
            const {bytesRead} = await handle.read(buffer, 0, length, position);
            if (bytesRead === 0) break;
            const lastNewline = buffer.lastIndexOf(NEWLINE, bytesRead - 1);
            if (lastNewline < 0) {
                // A line that Codex is still writing is read by the next scan.
                if (position + bytesRead >= size) break;
                // The middle of a line longer than a chunk: no spawn record is that long.
                position += bytesRead;
                scan.offset = position;
                continue;
            }
            // Only complete lines: the rest is read with the next chunk.
            const view = buffer.subarray(0, lastNewline + 1);
            // The lines with a marker, in file order, each once.
            const lineStarts = new Set<number>();
            for (const marker of SPAWN_MARKERS) {
                for (let at = view.indexOf(marker); at >= 0; at = view.indexOf(marker, view.indexOf(NEWLINE, at) + 1)) {
                    lineStarts.add(view.lastIndexOf(NEWLINE, at) + 1);
                }
            }
            for (const lineStart of [...lineStarts].sort((left, right) => left - right)) {
                const line = view.toString("utf8", lineStart, view.indexOf(NEWLINE, lineStart));
                for (const id of spawnedBy(line, threadId)) {
                    if (seen.has(id)) continue;
                    seen.add(id);
                    scan.threadIds.push(id);
                }
            }
            position += view.length;
            scan.offset = position;
        }
        // Not done only when the budget ended the scan: a last line that Codex is still writing, or that a crash
        // cut, is read when the file changes, not by polling it.
        scan.done = !(position >= limit && limit < size);
        return scan;
    } finally {
        await handle.close();
    }
}

/** The threads that one rollout record says the thread spawned. */
function spawnedBy(line: string, threadId: string): string[] {
    let record: unknown;
    try {
        record = JSON.parse(line);
    } catch {
        return [];
    }
    const payload = field(record, "payload");
    const item = field(payload, "item");
    const ids: unknown[] = [];
    if (field(item, "type") === "SubAgentActivity" && field(item, "kind") === "started"
        && field(payload, "thread_id") === threadId) {
        ids.push(field(item, "agent_thread_id"));
    } else if (field(item, "type") === "CollabAgentToolCall" && field(item, "tool") === "spawn_agent"
        && field(item, "sender_thread_id") === threadId) {
        const receivers = field(item, "receiver_thread_ids");
        if (Array.isArray(receivers)) ids.push(...receivers);
    }
    return ids.filter((id): id is string => typeof id === "string" && THREAD_ID_PATTERN.test(id));
}
