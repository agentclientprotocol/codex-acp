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
    const eventTimings: SessionListChangedTimings = {
        ...timings,
        debounceMs: 20,
        maxWaitMs: 50,
        // Out of reach of the test: only a file event can trigger a check.
        fallbackIntervalMs: 60 * 60_000,
    };
    let home: string;
    let writes = 0;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(home, {recursive: true, force: true});
    });

    /**
     * Repeats `write` until the watcher notifies. `fs.watch` can start reporting a little after it returns,
     * so a single write right after the watch begins can go unseen. Each write changes the page signature.
     */
    async function writeUntilNotified(
        signatures: Map<string, string>,
        notify: ReturnType<typeof createWatcher>["notify"],
        write: () => void,
    ): Promise<void> {
        notify.mockClear();
        await vi.waitFor(() => {
            if (notify.mock.calls.length === 0) {
                signatures.set("/repo/a", `write-${++writes}`);
                write();
            }
            expect(notify).toHaveBeenCalledWith("/repo/a");
        }, {timeout: 5_000, interval: 100});
    }

    it("checks after a write to the state DB WAL in CODEX_HOME", async () => {
        const signatures = new Map([["/repo/a", "a1"]]);
        const {watcher, notify} = createWatcher(signatures, home, eventTimings);
        watcher.observeList(list("/repo/a"), "a1");
        const wal = path.join(home, "state_5.sqlite-wal");

        await writeUntilNotified(signatures, notify, () => fs.appendFileSync(wal, "frame"));
        watcher.dispose();
    }, 10_000);

    it("keeps the watch of a WAL that macOS reports as renamed after a write in place", async () => {
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "frame");
        type Listener = (event: fs.WatchEventType, filename: string | null) => void;
        const realWatch = fs.watch.bind(fs) as unknown as (target: fs.PathLike, options: fs.WatchOptions, listener: Listener) => fs.FSWatcher;
        const walListeners: Listener[] = [];
        vi.spyOn(fs, "watch").mockImplementation(((target: fs.PathLike, options: fs.WatchOptions, listener: Listener) => {
            if (target === wal) walListeners.push(listener);
            return realWatch(target, options, target === wal ? () => {} : listener);
        }) as unknown as typeof fs.watch);
        const signatures = new Map([["/repo/a", "a2"]]);
        const {watcher, notify} = createWatcher(signatures, home, eventTimings);
        watcher.observeList(list("/repo/a"), "a1");
        expect(walListeners).toHaveLength(1);

        fs.appendFileSync(wal, "frame");
        walListeners[0]!("rename", "state_5.sqlite-wal");

        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("/repo/a"), {timeout: 2_000});
        expect(walListeners).toHaveLength(1);
        watcher.dispose();
    });

    it("keeps seeing writes after SQLite deletes and creates the WAL again", async () => {
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "frame");
        // Some file systems report a write in a directory to its watcher, others report only a file that
        // appears or goes. The test takes the second kind, so only the watch of the WAL itself sees a write.
        const walIdentity = () => {
            try {
                return String(fs.statSync(wal).ino);
            } catch {
                return "none";
            }
        };
        type Listener = (event: fs.WatchEventType, filename: string | null) => void;
        const realWatch = fs.watch.bind(fs) as unknown as (target: fs.PathLike, options: fs.WatchOptions, listener: Listener) => fs.FSWatcher;
        vi.spyOn(fs, "watch").mockImplementation(((target: fs.PathLike, options: fs.WatchOptions, listener: Listener) => {
            if (target !== home) return realWatch(target, options, listener);
            let reported = walIdentity();
            return realWatch(target, options, (event: fs.WatchEventType, filename: string | null) => {
                const current = walIdentity();
                if (current === reported) return;
                reported = current;
                listener(event, filename);
            });
        }) as unknown as typeof fs.watch);
        const signatures = new Map([["/repo/a", "a1"]]);
        const {watcher, notify} = createWatcher(signatures, home, eventTimings);
        watcher.observeList(list("/repo/a"), "a1");
        await writeUntilNotified(signatures, notify, () => fs.appendFileSync(wal, "frame"));

        // SQLite deletes the WAL when its last connection closes and creates it again on the next write.
        await writeUntilNotified(signatures, notify, () => {
            fs.rmSync(wal);
            fs.writeFileSync(wal, "frame");
        });
        await writeUntilNotified(signatures, notify, () => fs.appendFileSync(wal, "frame"));
        watcher.dispose();
    }, 20_000);
});
