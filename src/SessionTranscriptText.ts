import path from "node:path";
import {createZstdDecompress} from "node:zlib";
import {openRollout} from "./StoredSessionSettings";
import {recordOrNull} from "./permissions/json";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread, ThreadItem} from "./app-server/v2";

type TextMode = "transcriptRevision" | "transcriptTextSnapshot";
type Message = {role: "user" | "assistant" | "compact_summary"; text: string};

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

async function readSnapshot(client: CodexAppServerClient, thread: Thread, mode: TextMode, signal?: AbortSignal) {
    if (thread.path === null) return undefined;
    const initial = await revisionOf(thread.path);
    const {revision} = initial;
    signal?.throwIfAborted();
    if (mode === "transcriptRevision") return {revision};
    if (thread.historyMode === "legacy" && (!await legacyFitsBudget(thread.path, initial, signal))) {
        return {revision, messages: [], truncated: true};
    }
    const messages: Message[] = [];
    let bytes = 2;
    let truncated = false;
    const append = (item: ThreadItem): boolean => {
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
        const history = await client.threadRead({threadId: thread.id, includeTurns: true});
        for (const turn of history.thread.turns) {
            signal?.throwIfAborted();
            if (!turn.items.every(append)) break;
        }
    } else {
        for await (const page of client.threadItemPages(thread.id)) {
            signal?.throwIfAborted();
            if (!page.every(append)) break;
        }
    }
    signal?.throwIfAborted();
    if (revision !== (await revisionOf(thread.path)).revision) throw RequestError.internalError(undefined, "The transcript changed during the read. Retry the request.");
    return {revision, messages, truncated};
}

async function legacyFitsBudget(file: string, initial: Awaited<ReturnType<typeof revisionOf>>, signal?: AbortSignal): Promise<boolean> {
    if (!initial.compressed) return initial.size <= 64n * 1024n * 1024n;
    const rollout = await openRollout(file);
    const input = rollout.file.createReadStream({autoClose: false, signal});
    const decoded = input.pipe(createZstdDecompress());
    input.on("error", error => decoded.destroy(error));
    let bytes = 0;
    try {
        for await (const chunk of decoded) {
            signal?.throwIfAborted();
            bytes += (chunk as Buffer).length;
            if (bytes > 64 * 1024 * 1024) return false;
        }
        return true;
    } finally {
        input.destroy();
        decoded.destroy();
        await rollout.file.close();
    }
}

export async function readTranscriptText(client: CodexAppServerClient, thread: Thread, mode: TextMode, signal?: AbortSignal) {
    try { return await readSnapshot(client, thread, mode, signal); }
    catch (error) {
        signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}
