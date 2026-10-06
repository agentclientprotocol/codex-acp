import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MAX_WATCHED_SESSION_LISTS,
    SessionListChangedWatcher,
    type SessionListChangedTimings,
    type WatchedSessionList,
} from "../SessionListChangedWatcher";

const timings: SessionListChangedTimings = {
    debounceMs: 1_000,
    maxWaitMs: 2_000,
    watchTtlMs: 10 * 60_000,
    fallbackIntervalMs: 30_000,
};

function list(cwd: string): WatchedSessionList {
    return {cwd, options: {limit: 50, archived: "exclude"}};
}

function createWatcher(signatures: Map<string, string>, codexHome: string | null = null, watcherTimings = timings) {
    const readSignature = vi.fn(async (watched: WatchedSessionList) => signatures.get(watched.cwd) ?? "");
    const notify = vi.fn(async (_cwd: string) => {});
    const watcher = new SessionListChangedWatcher({
        codexHome: () => codexHome,
        readSignature,
        notify,
        timings: watcherTimings,
    });
    return {watcher, readSignature, notify};
}

describe("SessionListChangedWatcher", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("checks nothing before the client lists a cwd", async () => {
        const {watcher, readSignature} = createWatcher(new Map());

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(readSignature).not.toHaveBeenCalled();
        watcher.dispose();
    });

    it("notifies only the lists whose first page changed", async () => {
        const signatures = new Map([["/repo/a", "a1"], ["/repo/b", "b1"]]);
        const {watcher, notify} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");
        watcher.observeList(list("/repo/b"), "b1");

        signatures.set("/repo/b", "b2");
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(notify.mock.calls).toEqual([["/repo/b"]]);
        watcher.dispose();
    });

    it("does not notify again when nothing changed since the last notification", async () => {
        const signatures = new Map([["/repo/a", "a2"]]);
        const {watcher, notify, readSignature} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(1_000);
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(readSignature).toHaveBeenCalledTimes(2);
        expect(notify).toHaveBeenCalledTimes(1);
        watcher.dispose();
    });

    it("does not notify a change that the client already read", async () => {
        const signatures = new Map([["/repo/a", "a2"]]);
        const {watcher, notify} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");
        watcher.observeList(list("/repo/a"), "a2");

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(notify).not.toHaveBeenCalled();
        watcher.dispose();
    });

    it("debounces a burst of events into one check", async () => {
        const signatures = new Map([["/repo/a", "a2"]]);
        const {watcher, readSignature, notify} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(300);
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(300);
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(999);
        expect(readSignature).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(readSignature).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
        watcher.dispose();
    });

    it("checks within the max wait while events keep coming", async () => {
        const signatures = new Map([["/repo/a", "a1"]]);
        const {watcher, readSignature} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");

        for (let elapsed = 0; elapsed < 2_000; elapsed += 500) {
            watcher.trigger();
            await vi.advanceTimersByTimeAsync(500);
        }

        expect(readSignature).toHaveBeenCalledTimes(1);
        watcher.dispose();
    });

    it("stops watching a list that the client has not read for 10 minutes", async () => {
        const signatures = new Map([["/repo/a", "a2"]]);
        const {watcher, readSignature, notify} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");

        await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
        watcher.trigger();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(readSignature).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(watcher.watchedLists()).toEqual([]);
        watcher.dispose();
    });

    it(`watches at most ${MAX_WATCHED_SESSION_LISTS} lists and drops the least recently read`, () => {
        const {watcher} = createWatcher(new Map());
        for (let index = 0; index <= MAX_WATCHED_SESSION_LISTS; index++) {
            watcher.observeList(list(`/repo/${index}`), "");
        }

        const cwds = watcher.watchedLists().map(watched => watched.cwd);
        expect(cwds).toHaveLength(MAX_WATCHED_SESSION_LISTS);
        expect(cwds).not.toContain("/repo/0");
        expect(cwds).toContain(`/repo/${MAX_WATCHED_SESSION_LISTS}`);
        watcher.dispose();
    });

    it("keeps checking the other lists when one read fails", async () => {
        const signatures = new Map([["/repo/b", "b2"]]);
        const {watcher, readSignature, notify} = createWatcher(signatures);
        readSignature.mockImplementationOnce(async () => {
            throw new Error("app-server gone");
        });
        watcher.observeList(list("/repo/a"), "a1");
        watcher.observeList(list("/repo/b"), "b1");

        watcher.trigger();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(notify.mock.calls).toEqual([["/repo/b"]]);
        watcher.dispose();
    });

    it("sends nothing after dispose", async () => {
        const signatures = new Map([["/repo/a", "a2"]]);
        const {watcher, notify} = createWatcher(signatures);
        watcher.observeList(list("/repo/a"), "a1");

        watcher.trigger();
        watcher.dispose();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(notify).not.toHaveBeenCalled();
    });

    it("checks when the WAL size changes even without a file event", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-home-"));
        try {
            const wal = path.join(home, "state_5.sqlite-wal");
            fs.writeFileSync(wal, "a");
            const signatures = new Map([["/repo/a", "a2"]]);
            const {watcher, notify} = createWatcher(signatures, home);
            watcher.observeList(list("/repo/a"), "a1");

            fs.appendFileSync(wal, "more");
            await vi.advanceTimersByTimeAsync(30_000 + 2_000);

            expect(notify.mock.calls).toEqual([["/repo/a"]]);
            watcher.dispose();
        } finally {
            fs.rmSync(home, {recursive: true, force: true});
        }
    });
});

describe("SessionListChangedWatcher file events", () => {
    it("checks after a write to the state DB WAL in CODEX_HOME", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-home-"));
        try {
            const signatures = new Map([["/repo/a", "a2"]]);
            const {watcher, notify} = createWatcher(signatures, home, {
                ...timings,
                debounceMs: 20,
                maxWaitMs: 50,
            });
            watcher.observeList(list("/repo/a"), "a1");

            fs.writeFileSync(path.join(home, "state_5.sqlite-wal"), "frame");

            await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("/repo/a"), {timeout: 3_000});
            watcher.dispose();
        } finally {
            fs.rmSync(home, {recursive: true, force: true});
        }
    });
});
