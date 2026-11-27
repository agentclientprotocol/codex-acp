import {mkdtemp, writeFile, rm, stat, utimes, truncate} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Thread, ThreadItem} from "../../app-server/v2";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {readTranscriptText} from "../../SessionTranscriptText";
import {deferred} from "../acp-test-utils";
import {createMockConnections} from "./test-utils";

const directories: string[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});

async function stored() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-"));
    directories.push(directory);
    const file = path.join(directory, "rollout.jsonl");
    await writeFile(file, "stored transcript");
    const {mockCodexConnection} = createMockConnections();
    const client = new CodexAppServerClient(mockCodexConnection);
    const thread = {id: "stored", path: file, historyMode: "paginated"} as Thread;
    const backend = mockCodexConnection.sendRequest;
    backend.mockResolvedValue({thread});
    return {client, thread, file, backend};
}

describe("stored transcript text", () => {
    it("returns a cheap revision and sees equal-size edits even when mtime is restored", async () => {
        const {client, thread, file} = await stored();
        const pages = vi.spyOn(client, "threadItemPages");
        const first = await readTranscriptText(client, thread, "transcriptRevision");
        const old = await stat(file);
        await writeFile(file, "edited transcript");
        await utimes(file, old.atime, old.mtime);
        const second = await readTranscriptText(client, thread, "transcriptRevision");
        expect(second?.revision).not.toBe(first?.revision);
        expect(second).not.toHaveProperty("messages");
        expect(pages).not.toHaveBeenCalled();
    });

    it("projects paginated user and assistant text while excluding tools and reasoning", async () => {
        const {client, thread} = await stored();
        vi.spyOn(client, "threadItemPages").mockImplementation(async function* () {
            yield [
                {type: "userMessage", id: "u", content: [{type: "text", text: "user text", text_elements: []}, {type: "image", url: "hidden"}]},
                {type: "reasoning", id: "r", summary: ["private reasoning"], content: []},
                {type: "commandExecution", id: "t", command: "private command", aggregatedOutput: "private output"},
            ] as ThreadItem[];
            yield [{type: "agentMessage", id: "a", text: "assistant text"}, {type: "contextCompaction", id: "c"}] as ThreadItem[];
        });
        const snapshot = await readTranscriptText(client, thread, "transcriptTextSnapshot");
        expect(snapshot?.messages).toEqual([{role: "user", text: "user text"}, {role: "assistant", text: "assistant text"}]);
        expect(snapshot?.truncated).toBe(true);
    });

    it("retains complete messages before an oversized answer", async () => {
        const {client, thread} = await stored();
        vi.spyOn(client, "threadItemPages").mockImplementation(async function* () {
            yield [{type: "agentMessage", id: "one", text: "searchable answer"}, {type: "agentMessage", id: "two", text: "x".repeat(5 * 1024 * 1024)}] as ThreadItem[];
            throw new Error("An over-budget read must not request the next page");
        });
        const snapshot = await readTranscriptText(client, thread, "transcriptTextSnapshot");
        expect(snapshot?.messages).toEqual([{role: "assistant", text: "searchable answer"}]);
        expect(snapshot?.truncated).toBe(true);
    });

    it("rejects an edit during the read and propagates cancellation", async () => {
        const {client, thread, file} = await stored();
        vi.spyOn(client, "threadItemPages").mockImplementation(async function* () {
            await writeFile(file, "rewritten transcript");
            yield [];
        });
        await expect(readTranscriptText(client, thread, "transcriptTextSnapshot")).rejects.toThrow("changed during the read");
        const controller = new AbortController();
        controller.abort();
        await expect(readTranscriptText(client, thread, "transcriptTextSnapshot", controller.signal)).rejects.toMatchObject({code: -32800});
    });

    it.each(["paginated", "legacy"] as const)("cancels a pending %s history read without waiting for its response", async historyMode => {
        const {client, thread, backend} = await stored();
        thread.historyMode = historyMode;
        const pending = deferred<any>();
        const entered = deferred<void>();
        const controller = new AbortController();
        const wait = () => { entered.resolve(); return pending.promise; };
        backend.mockImplementation((method: string, params: any) =>
            method === "thread/items/list" || params.includeTurns ? wait() : Promise.resolve({thread}));
        const snapshot = readTranscriptText(client, thread, "transcriptTextSnapshot", controller.signal);
        const cancelled = expect(snapshot).rejects.toMatchObject({code: -32800});
        await entered.promise;
        controller.abort();
        await cancelled;
        pending.reject(new Error("Late history failure"));
    });

    it.each(["paginated", "legacy"] as const)("returns a partial snapshot when a pending %s read reaches the time budget", async historyMode => {
        const {client, thread, backend} = await stored();
        thread.historyMode = historyMode;
        vi.useFakeTimers();
        const pending = deferred<any>();
        const entered = deferred<void>();
        backend.mockImplementation(async (method: string, params: any) => {
            if (method === "thread/read" && !params.includeTurns) return {thread};
            if (method === "thread/items/list" && params.sortDirection === "desc") {
                return {data: [{item: {id: "last"}}], nextCursor: null};
            }
            entered.resolve();
            return pending.promise;
        });
        const snapshot = readTranscriptText(client, thread, "transcriptTextSnapshot");
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await snapshot;
        expect(result).toMatchObject({messages: [], truncated: true});
        expect(result?.revision).toEqual(expect.any(String));
        pending.reject(new Error("Late history failure"));
    });

    it("does not hydrate legacy history beyond the uncompressed size budget", async () => {
        const {client, thread, file, backend} = await stored();
        thread.historyMode = "legacy";
        await truncate(file, 64 * 1024 * 1024 + 1);
        expect(await readTranscriptText(client, thread, "transcriptTextSnapshot"))
            .toMatchObject({messages: [], truncated: true});
        expect(backend.mock.calls).toEqual([["thread/read", {threadId: thread.id, includeTurns: false}]]);
    });

    it("fails rather than returning text when final metadata verification times out", async () => {
        const {client, thread, backend} = await stored();
        vi.useFakeTimers();
        const pending = deferred<any>();
        const entered = deferred<void>();
        backend.mockImplementation(() => { entered.resolve(); return pending.promise; });
        const rejected = expect(readTranscriptText(client, thread, "transcriptRevision")).rejects.toThrow("scan budget");
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5_000);
        await rejected;
        pending.reject(new Error("Late metadata failure"));
    });
});
