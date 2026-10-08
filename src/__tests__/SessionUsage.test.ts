import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {Thread} from "../app-server/v2";
import {readFirstTokenCount, readLastTokenTotal, scanSpawnedThreads} from "../RolloutUsage";
import {SessionUsageIndex, type UsageSubject} from "../SessionUsage";
import {toPromptUsage, toTokenCount} from "../TokenCount";

interface Totals {
    input: number;
    cached?: number;
    cacheWrite?: number;
    output: number;
    reasoning?: number;
}

function breakdown(totals: Totals) {
    return {
        input_tokens: totals.input,
        cached_input_tokens: totals.cached ?? 0,
        cache_write_input_tokens: totals.cacheWrite ?? 0,
        output_tokens: totals.output,
        reasoning_output_tokens: totals.reasoning ?? 0,
        total_tokens: totals.input + totals.output,
    };
}

function tokenCount(total: Totals, last: Totals = total): string {
    return JSON.stringify({
        timestamp: "2026-10-08T00:00:00.000Z",
        type: "event_msg",
        payload: {type: "token_count", info: {total_token_usage: breakdown(total), last_token_usage: breakdown(last), model_context_window: 1000}, rate_limits: null},
    });
}

function spawn(parent: string, child: string, kind = "started"): string {
    return JSON.stringify({
        type: "event_msg",
        payload: {type: "item_completed", thread_id: parent, turn_id: "t", item: {type: "SubAgentActivity", id: "c", kind, agent_thread_id: child}},
    });
}

function filler(bytes: number): string {
    return JSON.stringify({type: "response_item", payload: {type: "function_call_output", output: "x".repeat(bytes)}});
}

function thread(id: string, file: string | null, overrides: Partial<Thread> = {}): Thread {
    return {
        id, sessionId: id, parentThreadId: null, threadSource: null, originator: null, forkedFromId: null, preview: "p",
        ephemeral: false, modelProvider: "openai", model: "gpt-5", reasoningEffort: null, createdAt: 1, updatedAt: 100,
        recencyAt: 100, status: {type: "notLoaded"}, path: file, cwd: "/repo", cliVersion: "0", section: null,
        sectionEnteredAt: null, projectId: null, historyMode: "paginated", source: "vscode", agentNickname: null,
        agentRole: null, gitInfo: null, name: null, turns: [],
        ...overrides,
    };
}

const PARENT = "01a0f439-251d-74a1-b2e7-c9eede7a0392";
const CHILD = "01a0f43d-7cf2-7812-90a7-807b823aa393";
const OTHER = "01a0f43d-7cf2-7812-90a7-807b823aa394";

let dir: string;

function write(name: string, lines: string[]): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-usage-"));
});

afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, {recursive: true, force: true});
});

describe("rollout reads", () => {
    it("reads the total of the last token_count, past windows that hold none and lines they cut", async () => {
        const file = write("a.jsonl", [
            tokenCount({input: 1, output: 1}),
            tokenCount({input: 10, cached: 4, cacheWrite: 1, output: 3, reasoning: 2}),
            filler(200 * 1024),
        ]);

        expect(await readLastTokenTotal(file)).toEqual({input: 10, cached: 4, cacheWrite: 1, output: 3, reasoning: 2});
        expect(await readLastTokenTotal(write("none.jsonl", [filler(10)]))).toBeNull();
        // A token_count line that the 16 KB window cuts in two.
        const cut = write("cut.jsonl", [tokenCount({input: 7, output: 7}), filler(16 * 1024 - 300)]);
        expect(await readLastTokenTotal(cut)).toEqual({input: 7, cached: 0, cacheWrite: 0, output: 7, reasoning: 0});
    });

    it("skips a line that mentions token_count but is no such record, and one Codex is still writing", async () => {
        const file = path.join(dir, "b.jsonl");
        fs.writeFileSync(file, [
            tokenCount({input: 5, output: 5}),
            JSON.stringify({type: "response_item", payload: {output: "\"token_count\" in a tool output"}}),
        ].join("\n") + "\n" + tokenCount({input: 9, output: 9}).slice(0, 80));

        expect(await readLastTokenTotal(file)).toEqual({input: 5, cached: 0, cacheWrite: 0, output: 5, reasoning: 0});
    });

    it("counts spawns only, in both record formats, and scans at most the given bytes per call", async () => {
        const collab = JSON.stringify({type: "event_msg", payload: {type: "item_completed", thread_id: PARENT, item: {
            type: "CollabAgentToolCall", tool: "spawn_agent", status: "completed", sender_thread_id: PARENT, receiver_thread_ids: [OTHER],
        }}});
        const file = write("parent.jsonl", [
            spawn(PARENT, CHILD, "interacted"),
            filler(1024 * 1024),
            collab,
            filler(1024 * 1024),
            spawn(PARENT, CHILD),
        ]);

        const first = await scanSpawnedThreads(file, PARENT, null, 1024 * 1024);
        expect(first.done).toBe(false);
        expect(first.threadIds).toEqual([]);
        let scan = first;
        while (!scan.done) scan = await scanSpawnedThreads(file, PARENT, scan, 1024 * 1024);
        expect(scan.threadIds).toEqual([OTHER, CHILD]);
    });

    it("keeps the file order of spawns of both formats within one chunk", async () => {
        const collab = JSON.stringify({type: "event_msg", payload: {type: "item_completed", thread_id: PARENT, item: {
            type: "CollabAgentToolCall", tool: "spawn_agent", sender_thread_id: PARENT, receiver_thread_ids: [OTHER],
        }}});
        const file = write("mixed.jsonl", [collab, spawn(PARENT, CHILD)]);

        expect((await scanSpawnedThreads(file, PARENT, null, 1024 * 1024)).threadIds).toEqual([OTHER, CHILD]);
    });

    it("reads the first token_count of a rollout past long lines", async () => {
        const file = write("fork.jsonl", [
            filler(700 * 1024),
            tokenCount({input: 110, output: 11}, {input: 10, output: 1}),
            tokenCount({input: 130, output: 13}),
        ]);

        expect(await readFirstTokenCount(file)).toEqual({
            total: {input: 110, cached: 0, cacheWrite: 0, output: 11, reasoning: 0},
            last: {input: 10, cached: 0, cacheWrite: 0, output: 1, reasoning: 0},
        });
    });

    it("finds the threads that a thread spawned under its own id, and goes on from where it stopped", async () => {
        const file = write("parent.jsonl", [
            spawn("01a0f400-0000-7000-8000-000000000000", OTHER),
            spawn(PARENT, CHILD),
            spawn(PARENT, CHILD, "completed"),
            filler(2 * 1024 * 1024),
        ]);
        const first = await scanSpawnedThreads(file, PARENT, null, 64 * 1024 * 1024);
        expect(first.threadIds).toEqual([CHILD]);
        expect(first.offset).toBe(fs.statSync(file).size);

        // A record that Codex is still writing waits for the next scan.
        const record = spawn(PARENT, OTHER);
        fs.appendFileSync(file, record.slice(0, 50));
        const partial = await scanSpawnedThreads(file, PARENT, first, 64 * 1024 * 1024);
        // Done all the same: a cut last line is read when the file changes, not polled.
        expect(partial).toEqual(first);
        fs.appendFileSync(file, record.slice(50) + "\n");
        expect((await scanSpawnedThreads(file, PARENT, partial, 64 * 1024 * 1024)).threadIds).toEqual([CHILD, OTHER]);
    });
});

describe("SessionUsageIndex", () => {
    function createIndex(threads: Map<string, Thread>) {
        const onRead = vi.fn((_subjects: UsageSubject[]) => {});
        const readThread = vi.fn(async (threadId: string) => threads.get(threadId) ?? null);
        const index = new SessionUsageIndex({readThread, onRead, nowSeconds: () => 10_000});
        return {index, onRead, readThread};
    }

    async function settle(index: SessionUsageIndex): Promise<void> {
        await vi.waitFor(() => expect(index.busy()).toBe(false));
    }

    it("reads the usage in the background, with fresh input apart from cache reads and writes", async () => {
        const file = write("a.jsonl", [tokenCount({input: 100, cached: 60, cacheWrite: 10, output: 20, reasoning: 5})]);
        const {index, onRead} = createIndex(new Map());
        const subject = {thread: thread(PARENT, file), archived: false};

        expect(index.usageOf(subject)).toBeUndefined();
        await settle(index);

        expect(onRead).toHaveBeenCalledWith([subject]);
        expect(index.usageOf(subject)).toEqual({
            inputTokens: 30, cachedReadTokens: 60, cachedWriteTokens: 10, outputTokens: 20, reasoningTokens: 5,
            model: "gpt-5", subagents: [],
        });
    });

    it("agrees with the usage that a session reports from the same Codex totals", async () => {
        const total = {input: 24098, cached: 23801, cacheWrite: 294, output: 120, reasoning: 40};
        const file = write("a.jsonl", [tokenCount(total)]);
        const {index} = createIndex(new Map());
        const subject = {thread: thread(PARENT, file), archived: false};
        index.usageOf(subject);
        await settle(index);

        const session = toPromptUsage(toTokenCount({
            totalTokens: total.input + total.output, inputTokens: total.input, cachedInputTokens: total.cached,
            cacheWriteInputTokens: total.cacheWrite, outputTokens: total.output, reasoningOutputTokens: total.reasoning,
        }));
        expect(index.usageOf(subject)).toMatchObject({
            inputTokens: session.inputTokens,
            cachedReadTokens: session.cachedReadTokens,
            cachedWriteTokens: session.cachedWriteTokens,
            outputTokens: session.outputTokens,
            reasoningTokens: session.thoughtTokens,
        });
    });

    it("counts only the own work of a fork, which its session_meta names, whatever the listed thread says", async () => {
        const meta = (forkedFrom: string | null) => JSON.stringify({type: "session_meta", payload: {id: PARENT, forked_from_id: forkedFrom}});
        const lines = [
            // The first total is the inherited 1000/100 plus the fork's first request of 50/5.
            tokenCount({input: 1050, cached: 800, output: 105}, {input: 50, output: 5}),
            tokenCount({input: 1200, cached: 900, output: 130}),
        ];
        const fork = write("fork.jsonl", [meta(OTHER), ...lines]);
        const plain = write("plain.jsonl", [meta(null), ...lines]);
        const {index} = createIndex(new Map());
        // `thread/list` gives no forkedFromId.
        const forkSubject = {thread: thread(PARENT, fork), archived: false};
        const plainSubject = {thread: thread(CHILD, plain), archived: false};
        index.usageOf(forkSubject);
        index.usageOf(plainSubject);
        await settle(index);

        expect(index.usageOf(forkSubject)).toMatchObject({inputTokens: 100, cachedReadTokens: 100, outputTokens: 30});
        expect(index.usageOf(plainSubject)).toMatchObject({inputTokens: 300, cachedReadTokens: 900, outputTokens: 130});
    });

    it("lists the subagents apart, each with its own usage and model, and leaves out a thread without usage", async () => {
        const childFile = write("child.jsonl", [tokenCount({input: 40, output: 4})]);
        const parentFile = write("parent.jsonl", [spawn(PARENT, CHILD), spawn(PARENT, OTHER), tokenCount({input: 10, output: 1})]);
        const threads = new Map([
            [CHILD, thread(CHILD, childFile, {model: "gpt-5-mini"})],
            [OTHER, thread(OTHER, null)],
        ]);
        const {index} = createIndex(threads);
        const subject = {thread: thread(PARENT, parentFile), archived: false};
        index.usageOf(subject);
        await settle(index);

        expect(index.usageOf(subject)).toEqual({
            inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1, reasoningTokens: 0, model: "gpt-5",
            subagents: [{sessionId: CHILD, model: "gpt-5-mini", inputTokens: 40, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 4, reasoningTokens: 0}],
        });
    });

    it("reads nothing again for a thread that did not change, and only its changed rollouts when it did", async () => {
        const childFile = write("child.jsonl", [tokenCount({input: 40, output: 4})]);
        const parentFile = write("parent.jsonl", [spawn(PARENT, CHILD), tokenCount({input: 10, output: 1})]);
        const {index, onRead, readThread} = createIndex(new Map([[CHILD, thread(CHILD, childFile)]]));
        const subject = {thread: thread(PARENT, parentFile), archived: false};
        index.usageOf(subject);
        await settle(index);
        const open = vi.spyOn(fs.promises, "open");

        index.usageOf(subject);
        expect(index.busy()).toBe(false);
        expect(open).not.toHaveBeenCalled();

        fs.appendFileSync(childFile, tokenCount({input: 80, output: 8}) + "\n");
        fs.appendFileSync(parentFile, tokenCount({input: 20, output: 2}) + "\n");
        const changed = {thread: thread(PARENT, parentFile, {updatedAt: 200}), archived: false};
        expect(index.usageOf(changed)).toMatchObject({inputTokens: 10});
        await settle(index);

        expect(index.usageOf(changed)).toMatchObject({inputTokens: 20, subagents: [{inputTokens: 80}]});
        // The subagent is read again because its rollout changed, which can come with another model.
        expect(readThread).toHaveBeenCalledTimes(2);
        expect(onRead).toHaveBeenCalledTimes(2);
        open.mockRestore();
    });

    it("reads a thread once more after the second of its updatedAt, for a record of the same second", async () => {
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        const file = write("a.jsonl", [tokenCount({input: 10, output: 1})]);
        let now = 100;
        const onRead = vi.fn();
        const index = new SessionUsageIndex({readThread: async () => null, onRead, nowSeconds: () => now});
        const subject = {thread: thread(PARENT, file, {updatedAt: 100}), archived: false};
        index.usageOf(subject);
        await vi.waitFor(async () => {
            await vi.advanceTimersByTimeAsync(1);
            expect(index.usageOf(subject)).toMatchObject({inputTokens: 10});
        });

        fs.appendFileSync(file, tokenCount({input: 30, output: 3}) + "\n");
        now = 103;
        await vi.advanceTimersByTimeAsync(3_000);
        await vi.waitFor(async () => {
            await vi.advanceTimersByTimeAsync(1);
            expect(index.usageOf(subject)).toMatchObject({inputTokens: 30});
        });
        expect(onRead).toHaveBeenCalledTimes(2);
        index.dispose();
    });

    it("lists a subagent once Codex has its rollout, and goes on with the parent when it has none yet", async () => {
        const childFile = path.join(dir, "child.jsonl");
        const parentFile = write("parent.jsonl", [spawn(PARENT, CHILD), tokenCount({input: 10, output: 1})]);
        const threads = new Map([[CHILD, thread(CHILD, childFile)]]);
        const {index} = createIndex(threads);
        const subject = {thread: thread(PARENT, parentFile), archived: false};
        index.usageOf(subject);
        await settle(index);
        expect(index.usageOf(subject)).toMatchObject({inputTokens: 10, subagents: []});

        fs.writeFileSync(childFile, tokenCount({input: 40, output: 4}) + "\n");
        fs.appendFileSync(parentFile, tokenCount({input: 20, output: 2}) + "\n");
        const changed = {thread: thread(PARENT, parentFile, {updatedAt: 200}), archived: false};
        index.usageOf(changed);
        await settle(index);
        expect(index.usageOf(changed)).toMatchObject({inputTokens: 20, subagents: [{sessionId: CHILD, inputTokens: 40}]});
    });

    it("reports no change for a read that gives the usage it had", async () => {
        const file = write("a.jsonl", [tokenCount({input: 10, output: 1})]);
        const {index, onRead} = createIndex(new Map());
        index.usageOf({thread: thread(PARENT, file), archived: false});
        await settle(index);
        index.usageOf({thread: thread(PARENT, file, {updatedAt: 300}), archived: false});
        await settle(index);

        expect(onRead).toHaveBeenCalledTimes(1);
    });

    it("reads nothing after dispose", async () => {
        vi.useFakeTimers();
        const file = write("a.jsonl", [tokenCount({input: 10, output: 1})]);
        const {index, onRead} = createIndex(new Map());
        index.usageOf({thread: thread(PARENT, file), archived: false});
        index.dispose();
        await vi.advanceTimersByTimeAsync(10);

        expect(onRead).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
