import {mkdtemp, writeFile, rm, stat, utimes} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Thread, ThreadItem} from "../../app-server/v2";
import {readTranscriptText} from "../../SessionTranscriptText";
import {createCodexMockTestFixture} from "../acp-test-utils";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive: true, force: true}))); });

async function stored() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-"));
    directories.push(directory);
    const file = path.join(directory, "rollout.jsonl");
    await writeFile(file, "stored transcript");
    const fixture = createCodexMockTestFixture();
    return {client: fixture.getCodexAppServerClient(), thread: {id: "stored", path: file, historyMode: "paginated"} as Thread, file};
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
        await expect(readTranscriptText(client, thread, "transcriptTextSnapshot", controller.signal)).rejects.toMatchObject({name: "AbortError"});
    });
});
