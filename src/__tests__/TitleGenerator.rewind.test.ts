import {createHash} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {SessionState} from "../CodexAcpServer";
import type {SessionIndexHost} from "../SessionIndexService";
import {SessionIndexTitles} from "../SessionIndexTitles";
import {rewindSession} from "../SessionRewind";
import {SessionWriteQueue} from "../SessionWriteQueue";
import {TitleGenerator, type SerializeTitleWrite} from "../TitleGenerator";
import type {Thread} from "../app-server/v2";
import {deferred} from "./acp-test-utils";

const titleResult = (title: string) => ({
    turn: {items: [{type: "agentMessage", text: JSON.stringify({title})}]},
});
const flush = () => vi.advanceTimersByTimeAsync(0);

function fixture(queued = false, historyMode: "legacy" | "paginated" = "legacy") {
    const state = {sessionTitleSource: "unset"} as SessionState;
    const thread = {
        id: "session", historyMode,
        turns: [{id: "turn", items: [{type: "userMessage", id: "user", content: [{type: "text", text: "discard this"}]}]}],
    } as Thread;
    const events: string[] = [];
    const client = {
        threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
        runTurn: vi.fn().mockResolvedValue(titleResult("Discarded title")),
        threadSetName: vi.fn().mockResolvedValue({}),
        threadReadWithHistory: vi.fn(async () => ({thread: structuredClone(thread)})),
        threadRollback: vi.fn(async () => {
            events.push("rollback");
            thread.turns = [];
            return {thread};
        }),
        threadRevert: vi.fn(async () => {
            events.push("revert");
            thread.turns = [];
            return {thread};
        }),
    };
    const writes = new SessionWriteQueue();
    const titles = new SessionIndexTitles({session: () => state} as unknown as SessionIndexHost, writes);
    const serialize: SerializeTitleWrite = queued
        ? (title, write) => titles.writeAutomaticTitle("session", title, write)
        : (_title, write) => write();
    const writer = vi.fn(serialize);
    const native = client as unknown as CodexAppServerClient;
    const generator = new TitleGenerator(native, "session", "/test/cwd", () => state.sessionTitleSource, writer);
    const beforeMutation = vi.fn(() => generator.invalidateForRewind());
    const rewind = () => rewindSession({
        sessionId: "session",
        beforeMessage: {
            messageId: "user",
            messageFingerprint: `sha256:${createHash("sha256").update("discard this").digest("hex")}`,
            messageOccurrence: 1,
        },
    }, native, {beforeMutation});
    return {client, generator, writer, state, writes, events, thread, rewind, beforeMutation};
}

describe("TitleGenerator rewind invalidation", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not wait for a pending model result and never writes it after rewind", async () => {
        const f = fixture();
        const model = deferred<ReturnType<typeof titleResult>>();
        f.client.runTurn.mockReturnValueOnce(model.promise);
        f.generator.onTurnCompleted("discard this");
        await flush();
        expect(f.client.runTurn).toHaveBeenCalledOnce();

        await expect(f.rewind()).resolves.toEqual({rewound: true});
        // Even waitForIdle no longer waits for the invalidated model request.
        await f.generator.waitForIdle(5_000);
        model.resolve(titleResult("Discarded title"));
        await flush();

        expect(f.writer).not.toHaveBeenCalled();
        expect(f.client.threadSetName).not.toHaveBeenCalled();
    });

    it("skips the model if the ephemeral thread starts after invalidation", async () => {
        const f = fixture();
        const start = deferred<{thread: {id: string}}>();
        f.client.threadStart.mockReturnValueOnce(start.promise);
        f.generator.onTurnCompleted("discard this");
        await f.generator.invalidateForRewind();
        start.resolve({thread: {id: "old-ephemeral"}});
        await flush();

        expect(f.client.runTurn).not.toHaveBeenCalled();
        f.generator.onTurnCompleted("replacement message");
        await flush();
        expect(f.client.runTurn).toHaveBeenCalledOnce();
        expect(f.client.runTurn.mock.calls[0]![0].input[0].text).toContain("replacement message");
        f.generator.observeRename();
        await f.generator.waitForIdle(5_000);
    });

    it("invalidates a queued write without waiting for the session queue", async () => {
        const f = fixture(true);
        const blocker = deferred<void>();
        const blockingWrite = f.writes.run("session", () => blocker.promise);
        f.generator.onTurnCompleted("discard this");
        await flush();
        expect(f.writer).toHaveBeenCalledOnce();
        expect(f.client.threadSetName).not.toHaveBeenCalled();

        await expect(f.rewind()).resolves.toEqual({rewound: true});
        blocker.resolve();
        await blockingWrite;
        await flush();
        expect(f.client.threadSetName).not.toHaveBeenCalled();
        expect(f.state.automaticTitleEcho).toBeUndefined();

        f.client.runTurn.mockResolvedValueOnce(titleResult("Replacement title"));
        f.generator.onTurnCompleted("replacement message");
        await flush();
        expect(f.client.threadSetName).toHaveBeenCalledExactlyOnceWith({threadId: "session", name: "Replacement title"});
        f.generator.observeRename();
        await f.generator.waitForIdle(5_000);
    });

    it("does not let an obsolete queued callback rearm a newer generation", async () => {
        const f = fixture(true);
        const blocker = deferred<void>();
        const blockingWrite = f.writes.run("session", () => blocker.promise);
        f.generator.onTurnCompleted("discard this");
        await flush();
        expect(f.writer).toHaveBeenCalledOnce();
        await f.generator.invalidateForRewind();

        const current = deferred<ReturnType<typeof titleResult>>();
        f.client.runTurn.mockReturnValueOnce(current.promise);
        f.generator.onTurnCompleted("replacement");
        await flush();
        blocker.resolve();
        await blockingWrite;
        await flush();
        f.generator.retryAfterFailedRename();
        f.generator.onTurnCompleted("duplicate");
        expect(f.client.threadStart).toHaveBeenCalledTimes(2);
        expect(f.client.threadSetName).not.toHaveBeenCalled();

        current.resolve(titleResult("Replacement title"));
        await flush();
        expect(f.client.threadSetName).toHaveBeenCalledExactlyOnceWith({threadId: "session", name: "Replacement title"});
        f.generator.observeRename();
        await f.generator.waitForIdle(5_000);
    });

    it.each(["legacy", "paginated"] as const)("awaits a dispatched write acknowledgement before %s mutation, without waiting for its echo", async mode => {
        const f = fixture(true, mode);
        const ack = deferred<void>();
        f.client.threadSetName.mockImplementationOnce(async () => {
            await ack.promise;
            f.events.push("title accepted");
            return {};
        });
        f.generator.onTurnCompleted("discard this");
        await flush();
        expect(f.client.threadSetName).toHaveBeenCalledOnce();

        let settled = false;
        const rewind = f.rewind().then(result => { settled = true; return result; });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.beforeMutation).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        expect(f.events).toEqual([]);
        expect(f.thread.turns).toHaveLength(1);

        ack.resolve();
        await expect(rewind).resolves.toEqual({rewound: true});
        expect(f.events).toEqual(["title accepted", mode === "legacy" ? "rollback" : "revert"]);
        await f.generator.waitForIdle(5_000);
    });

    it.each([false, true])("fails closed on an unacknowledged dispatched write (already rejected: %s)", async alreadyRejected => {
        const f = fixture();
        const ack = deferred<Record<string, never>>();
        f.client.threadSetName.mockReturnValueOnce(ack.promise);
        f.generator.onTurnCompleted("discard this");
        await flush();
        expect(f.client.threadSetName).toHaveBeenCalledOnce();
        if (alreadyRejected) {
            ack.reject(new Error("connection lost"));
            await flush();
        }

        const failed = expect(f.rewind()).rejects.toThrow("title write");
        await flush();
        if (!alreadyRejected) ack.reject(new Error("connection lost"));
        await failed;
        // Best-effort generation swallowing the error must not turn a retry into success.
        await expect(f.rewind()).rejects.toThrow("title write");
        expect(f.events).toEqual([]);
        expect(f.thread.turns).toHaveLength(1);
    });

    it("lets a later generation finish while ignoring multiple obsolete model results", async () => {
        const f = fixture();
        const first = deferred<ReturnType<typeof titleResult>>();
        const second = deferred<ReturnType<typeof titleResult>>();
        const current = deferred<ReturnType<typeof titleResult>>();
        f.client.runTurn.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(current.promise);
        f.generator.onTurnCompleted("first");
        await flush();
        await f.generator.invalidateForRewind();
        f.generator.onTurnCompleted("second");
        await flush();
        await f.generator.invalidateForRewind();
        f.generator.onTurnCompleted("current");
        await flush();

        // A stale result must not set droppedForExplicitTitle for the current generation.
        f.state.sessionTitleSource = "explicit";
        second.resolve(titleResult("Second discarded title"));
        first.resolve(titleResult("First discarded title"));
        await flush();
        f.state.sessionTitleSource = "unset";
        f.generator.retryAfterFailedRename();
        f.generator.onTurnCompleted("duplicate");
        expect(f.client.threadStart).toHaveBeenCalledTimes(3);

        let idle = false;
        const wait = f.generator.waitForIdle(5_000).then(() => { idle = true; });
        await flush();
        expect(idle).toBe(false);
        current.resolve(titleResult("Current title"));
        await flush();
        expect(f.client.threadSetName).toHaveBeenCalledExactlyOnceWith({threadId: "session", name: "Current title"});
        f.generator.observeRename();
        await wait;
    });

    it.each(["explicit", "unknown", "existing"])("preserves %s title protection across rewind", async protection => {
        const f = fixture();
        if (protection === "existing") f.generator.markExistingTitle();
        else f.state.sessionTitleSource = protection as "explicit" | "unknown";

        await f.generator.invalidateForRewind();
        f.generator.onTurnCompleted("replacement");
        expect(f.client.threadStart).not.toHaveBeenCalled();
    });

    it("preserves an explicit name set while invalidated generation is pending", async () => {
        const f = fixture();
        const model = deferred<ReturnType<typeof titleResult>>();
        f.client.runTurn.mockReturnValueOnce(model.promise);
        f.generator.onTurnCompleted("discard this");
        await flush();
        f.state.sessionTitleSource = "explicit";
        f.generator.markExistingTitle();
        await f.generator.invalidateForRewind();
        model.resolve(titleResult("Discarded title"));
        await flush();
        f.generator.retryAfterFailedRename();
        f.generator.onTurnCompleted("replacement");

        expect(f.client.threadStart).toHaveBeenCalledOnce();
        expect(f.client.threadSetName).not.toHaveBeenCalled();
    });

    it("allows a later title when an explicit rename attempted during invalidation fails", async () => {
        const f = fixture();
        const model = deferred<ReturnType<typeof titleResult>>();
        f.client.runTurn.mockReturnValueOnce(model.promise);
        f.generator.onTurnCompleted("discard this");
        await flush();
        f.state.sessionTitleSource = "explicit";
        await f.generator.invalidateForRewind();
        f.state.sessionTitleSource = "unset";
        f.generator.retryAfterFailedRename();
        f.client.runTurn.mockResolvedValueOnce(titleResult("Replacement title"));
        f.generator.onTurnCompleted("replacement");
        model.resolve(titleResult("Discarded title"));
        await flush();

        expect(f.client.threadSetName).toHaveBeenCalledExactlyOnceWith({threadId: "session", name: "Replacement title"});
        f.generator.observeRename();
        await f.generator.waitForIdle(5_000);
    });

    it("keeps an acknowledged title when rewind happens while its echo is pending", async () => {
        const f = fixture();
        f.generator.onTurnCompleted("discard this");
        await flush();
        expect(f.client.threadSetName).toHaveBeenCalledOnce();
        await f.generator.invalidateForRewind();
        await f.generator.waitForIdle(5_000);
        f.generator.onTurnCompleted("replacement");
        expect(f.client.threadStart).toHaveBeenCalledOnce();
    });
});
