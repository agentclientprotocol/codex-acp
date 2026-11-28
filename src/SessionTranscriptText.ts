import path from "node:path";
import {createZstdDecompress} from "node:zlib";
import {openRollout} from "./StoredSessionSettings";
import {recordOrNull} from "./permissions/json";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {type CodexAppServerClient, HistoryReadTimeoutError} from "./CodexAppServerClient";
import {throwIfRequestCancelled} from "./RequestCancellation";
import type {Thread, ThreadItem} from "./app-server/v2";

type TextMode = "transcriptRevision" | "transcriptTextSnapshot";
type Message = {role: "user" | "assistant" | "compact_summary"; text: string};
type TextSnapshot = {revision: string; messages?: Message[]; truncated?: boolean};

const MAX_SCAN_ITEMS = 10_000;
const MAX_READ_MS = 60_000;

function readOptions(signal?: AbortSignal) {
    return {deadline: Date.now() + MAX_READ_MS, ...(signal ? {signal} : {})};
}

function transcriptChanged(): RequestError {
    return RequestError.internalError({reason: "transcriptChanged"}, "The transcript changed during the read. Retry the request.");
}

function assertSameTranscript(expected: Thread, actual: Thread): void {
    if (actual.id !== expected.id || actual.path !== expected.path || actual.cwd !== expected.cwd
        || actual.historyMode !== expected.historyMode) throw transcriptChanged();
}

export function transcriptTextOptions(meta: unknown, ids: string[]): {mode: TextMode; cwd: string} | null {
    const air = recordOrNull(recordOrNull(recordOrNull(meta)?.["jetbrains"])?.["air"]) ?? {};
    if (air["include"] === undefined) return null;
    if ((air["include"] !== "transcriptRevision" && air["include"] !== "transcriptTextSnapshot") || ids.length !== 1
        || typeof air["cwd"] !== "string" || !path.isAbsolute(air["cwd"])) {
        throw RequestError.invalidParams(undefined, "Transcript text requires one session id, an absolute cwd, and a valid mode");
    }
    return {mode: air["include"], cwd: air["cwd"]};
}

async function revisionOf(file: string) {
    const rollout = await openRollout(file);
    try {
        const info = await rollout.file.stat({bigint: true});
        if (!info.isFile()) throw new Error("The transcript is not a file");
        const revision = [rollout.compressed, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
        return {revision, size: info.size, compressed: rollout.compressed};
    } finally { await rollout.file.close(); }
}

async function readSnapshot(client: CodexAppServerClient, thread: Thread, mode: TextMode, signal?: AbortSignal): Promise<TextSnapshot | undefined> {
    throwIfRequestCancelled(signal);
    if (thread.path === null) return undefined;
    const options = readOptions(signal);
    let initial: Awaited<ReturnType<typeof revisionOf>>;
    try { initial = await revisionOf(thread.path); }
    catch (error) {
        throwIfRequestCancelled(signal);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    const {revision} = initial;
    const projection = mode === "transcriptRevision" ? null : await readMessages(client, thread, initial, options);
    const {thread: current} = await client.threadRead({threadId: thread.id, includeTurns: false}, options);
    // History requests resolve the ID again, so the selected rollout can differ from the original path.
    assertSameTranscript(thread, current);
    if (revision !== (await revisionOf(thread.path)).revision) throw transcriptChanged();
    throwIfRequestCancelled(signal);
    if (projection === null) return {revision};
    return {revision, ...projection};
}

async function readMessages(client: CodexAppServerClient, thread: Thread, initial: Awaited<ReturnType<typeof revisionOf>>, options: ReturnType<typeof readOptions>) {
    const {signal} = options;
    const messages: Message[] = [];
    let bytes = 2;
    let truncated = false;
    let items = 0;
    const append = (item: ThreadItem): boolean => {
        if (Date.now() >= options.deadline) throw new HistoryReadTimeoutError();
        if (items++ >= MAX_SCAN_ITEMS) { truncated = true; return false; }
        let message: Message;
        if (item.type === "userMessage") {
            message = {role: "user", text: item.content.filter(part => part.type === "text").map(part => part.text).join("\n")};
        } else if (item.type === "agentMessage") {
            message = {role: "assistant", text: item.text};
        } else {
            if (item.type === "contextCompaction") truncated = true;
            return true;
        }
        if (!message.text) return true;
        bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
        if (bytes > 4 * 1024 * 1024) { truncated = true; return false; }
        messages.push(message);
        return true;
    };
    if (thread.historyMode === "legacy") {
        if (thread.path === null || !await legacyFitsBudget(thread.path, initial, options)) {
            return {messages, truncated: true};
        }
        const history = await client.threadRead({threadId: thread.id, includeTurns: true}, options);
        assertSameTranscript(thread, history.thread);
        for (const turn of history.thread.turns) {
            throwIfRequestCancelled(signal);
            if (!turn.items.every(append)) break;
        }
    } else {
        for await (const page of client.threadItemPages(thread.id, options)) {
            throwIfRequestCancelled(signal);
            if (!page.every(append)) break;
        }
    }
    throwIfRequestCancelled(signal);
    return {messages, truncated};
}

async function legacyFitsBudget(file: string, initial: Awaited<ReturnType<typeof revisionOf>>, options: ReturnType<typeof readOptions>): Promise<boolean> {
    if (Date.now() >= options.deadline) throw new HistoryReadTimeoutError();
    if (!initial.compressed) return initial.size <= 64n * 1024n * 1024n;
    const timeout = AbortSignal.timeout(Math.max(0, options.deadline - Date.now()));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const rollout = await openRollout(file);
    const input = rollout.file.createReadStream({autoClose: false, signal});
    const decoded = input.pipe(createZstdDecompress());
    input.on("error", error => decoded.destroy(error));
    let bytes = 0;
    try {
        for await (const chunk of decoded) {
            throwIfRequestCancelled(signal);
            bytes += (chunk as Buffer).length;
            if (bytes > 64 * 1024 * 1024) return false;
        }
        return true;
    } catch (error) {
        throwIfRequestCancelled(options.signal);
        if (timeout.aborted) throw new HistoryReadTimeoutError();
        throw error;
    } finally {
        input.destroy();
        decoded.destroy();
        await rollout.file.close();
    }
}

export async function readTranscriptText(client: CodexAppServerClient, thread: Thread, mode: TextMode, signal?: AbortSignal) {
    try { return await readSnapshot(client, thread, mode, signal); }
    catch (error) {
        throwIfRequestCancelled(signal);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw transcriptChanged();
        if (error instanceof HistoryReadTimeoutError) {
            throw RequestError.internalError({reason: "transcriptReadTimeout"}, "Transcript reading timed out. Retry later.");
        }
        throw error;
    }
}
