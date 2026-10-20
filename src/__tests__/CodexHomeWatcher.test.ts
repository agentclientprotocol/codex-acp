import {afterEach, beforeEach, describe, expect, it, onTestFinished, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {ARCHIVED_SESSIONS_DIR, CodexHomeWatcher} from "../CodexHomeWatcher";

/** Out of reach of most tests: only a file event reports a change. */
const NO_FALLBACK = 60 * 60_000;

function createWatcher(home: string, fallbackIntervalMs = NO_FALLBACK) {
    const stateChanged = vi.fn();
    const archiveMoved = vi.fn((_threadId: string) => {});
    const watcher = new CodexHomeWatcher(home, {stateChanged, archiveMoved}, fallbackIntervalMs);
    onTestFinished(() => watcher.stop());
    return {watcher, stateChanged, archiveMoved};
}

describe("CodexHomeWatcher", () => {
    let home: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-home-"));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        fs.rmSync(home, {recursive: true, force: true});
    });

    it("reports a change of the WAL size even without a file event", async () => {
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "a");
        vi.spyOn(fs, "watch").mockImplementation((() => Object.assign(new (class {})(), {
            on() { return this; },
            close() {},
        })) as unknown as typeof fs.watch);
        vi.useFakeTimers();
        const {stateChanged} = createWatcher(home, 30_000);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(stateChanged).not.toHaveBeenCalled();
        fs.appendFileSync(wal, "more");
        await vi.advanceTimersByTimeAsync(30_000);

        expect(stateChanged).toHaveBeenCalledTimes(1);
    });

    it("reports a write to the state DB WAL in CODEX_HOME", async () => {
        const {stateChanged} = createWatcher(home);
        const wal = path.join(home, "state_5.sqlite-wal");

        await vi.waitFor(() => {
            fs.appendFileSync(wal, "frame");
            expect(stateChanged).toHaveBeenCalled();
        }, {timeout: 5_000, interval: 100});
    }, 10_000);

    it("reports the thread of a rollout that moves into or out of archived_sessions", async () => {
        const archive = path.join(home, ARCHIVED_SESSIONS_DIR);
        fs.mkdirSync(archive);
        const {archiveMoved} = createWatcher(home);
        const threadId = "01a0637c-5b99-7242-9064-04545d605fdb";
        const rollout = path.join(archive, `rollout-2026-10-08T13-21-48-${threadId}.jsonl`);

        // Moves the rollout in and out by turns. The test tracks where it is, so it never checks the file first.
        let present = false;
        await vi.waitFor(() => {
            if (present) fs.rmSync(rollout);
            else fs.writeFileSync(rollout, "{}\n");
            present = !present;
            expect(archiveMoved).toHaveBeenCalledWith(threadId);
        }, {timeout: 5_000, interval: 100});
        expect(archiveMoved.mock.calls.every(([id]) => id === threadId)).toBe(true);
    }, 10_000);

    it("reports an append to the session name log, which a rename writes", async () => {
        const log = path.join(home, "session_index.jsonl");
        fs.writeFileSync(log, "");
        const {stateChanged} = createWatcher(home);

        await vi.waitFor(() => {
            fs.appendFileSync(log, "{\"id\":\"a\"}\n");
            expect(stateChanged).toHaveBeenCalled();
        }, {timeout: 5_000, interval: 100});
    }, 10_000);

    it("watches archived_sessions once Codex creates it", async () => {
        const {archiveMoved} = createWatcher(home, 50);
        const threadId = "01a0637c-5b99-7242-9064-04545d605fdc";
        fs.mkdirSync(path.join(home, ARCHIVED_SESSIONS_DIR));
        const rollout = path.join(home, ARCHIVED_SESSIONS_DIR, `rollout-2026-10-08T13-21-48-${threadId}.jsonl`);

        await vi.waitFor(() => {
            fs.writeFileSync(rollout, "{}\n");
            fs.rmSync(rollout);
            expect(archiveMoved).toHaveBeenCalledWith(threadId);
        }, {timeout: 5_000, interval: 100});
    }, 10_000);

    it("closes every watch and the fallback check when stopped", () => {
        fs.writeFileSync(path.join(home, "state_5.sqlite-wal"), "a");
        fs.mkdirSync(path.join(home, ARCHIVED_SESSIONS_DIR));
        const realWatch = fs.watch.bind(fs) as unknown as typeof fs.watch;
        const open = new Set<fs.FSWatcher>();
        vi.spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
            const watcher = (realWatch as (...a: unknown[]) => fs.FSWatcher)(...args);
            open.add(watcher);
            const close = watcher.close.bind(watcher);
            watcher.close = () => {
                open.delete(watcher);
                close();
            };
            return watcher;
        }) as unknown as typeof fs.watch);
        vi.useFakeTimers();
        const {watcher} = createWatcher(home, 30_000);
        expect(open.size).toBe(3);
        expect(vi.getTimerCount()).toBe(1);

        watcher.stop();

        expect(open.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("CodexHomeWatcher WAL identity", () => {
    let home: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(home, {recursive: true, force: true});
    });

    /** Repeats `write` until the watcher reports a change: `fs.watch` can start reporting a little late. */
    async function writeUntilReported(stateChanged: ReturnType<typeof vi.fn>, write: () => void): Promise<void> {
        stateChanged.mockClear();
        await vi.waitFor(() => {
            if (stateChanged.mock.calls.length === 0) write();
            expect(stateChanged).toHaveBeenCalled();
        }, {timeout: 5_000, interval: 100});
    }

    type Listener = (event: fs.WatchEventType, filename: string | null) => void;

    /**
     * Watches a WAL whose own watch reports only what the test sends, and returns those listeners. With
     * `dirListeners`, the watch of CODEX_HOME reports only what the test sends too.
     */
    function watchWalByHand(wal: string, dirListeners: Listener[] | null = null) {
        const realWatch = fs.watch.bind(fs) as unknown as (target: fs.PathLike, options: fs.WatchOptions, listener: Listener) => fs.FSWatcher;
        const walListeners: Listener[] = [];
        vi.spyOn(fs, "watch").mockImplementation(((target: fs.PathLike, options: fs.WatchOptions, listener: Listener) => {
            if (target === wal) walListeners.push(listener);
            if (target === home && dirListeners !== null) dirListeners.push(listener);
            const byHand = target === wal || (target === home && dirListeners !== null);
            return realWatch(target, options, byHand ? () => {} : listener);
        }) as unknown as typeof fs.watch);
        return walListeners;
    }

    function onPlatform(platform: NodeJS.Platform): void {
        const original = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", {...original, value: platform});
        onTestFinished(() => {
            Object.defineProperty(process, "platform", original);
        });
    }

    it("keeps the watch of a WAL that macOS reports as renamed after a write in place", async () => {
        onPlatform("darwin");
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "frame");
        const walListeners = watchWalByHand(wal);
        const {stateChanged} = createWatcher(home);
        expect(walListeners).toHaveLength(1);

        fs.appendFileSync(wal, "frame");
        walListeners[0]!("rename", "state_5.sqlite-wal");

        expect(stateChanged).toHaveBeenCalled();
        expect(walListeners).toHaveLength(1);
    });

    it("keeps the WAL watch on Linux when the reported creation time follows the change time", () => {
        onPlatform("linux");
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "frame");
        // Without statx, libuv reports the change time as the creation time, so it moves with every write.
        const realStat = fs.statSync.bind(fs) as (file: fs.PathLike) => fs.Stats;
        let writes = 0;
        vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike) => {
            const stats = realStat(file);
            return file === wal ? Object.assign(Object.create(stats) as fs.Stats, {birthtimeMs: ++writes}) : stats;
        }) as unknown as typeof fs.statSync);
        const dirListeners: Listener[] = [];
        const walListeners = watchWalByHand(wal, dirListeners);
        createWatcher(home);
        expect(walListeners).toHaveLength(1);

        for (let write = 0; write < 3; write++) {
            fs.appendFileSync(wal, "frame");
            dirListeners[0]!("change", "state_5.sqlite-wal");
        }
        expect(walListeners).toHaveLength(1);

        // SQLite deletes the WAL and creates it again with the same inode: the watch of the old file says "rename".
        walListeners[0]!("rename", "state_5.sqlite-wal");
        expect(walListeners).toHaveLength(2);
    });

    it("watches the WAL again after a rename event outside macOS, whatever its inode", async () => {
        onPlatform("linux");
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "frame");
        const walListeners = watchWalByHand(wal);
        createWatcher(home);
        expect(walListeners).toHaveLength(1);

        // inotify reports the deleted file as "rename"; a new file can carry the same inode number.
        walListeners[0]!("rename", "state_5.sqlite-wal");

        expect(walListeners).toHaveLength(2);
    });

    it("keeps seeing writes after SQLite deletes and creates the WAL again", async () => {
        const wal = path.join(home, "state_5.sqlite-wal");
        fs.writeFileSync(wal, "frame");
        // Some file systems report a write in a directory to its watcher, others report only a file that
        // appears or goes. The test takes the second kind, so only the watch of the WAL itself sees a write.
        // Linux gives the new file the inode of the deleted one, so the creation time tells them apart.
        const walIdentity = () => {
            try {
                const stats = fs.statSync(wal);
                return `${stats.ino}:${stats.birthtimeMs}`;
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
        const {stateChanged} = createWatcher(home);
        await writeUntilReported(stateChanged, () => fs.appendFileSync(wal, "frame"));

        // SQLite deletes the WAL when its last connection closes and creates it again on the next write.
        await writeUntilReported(stateChanged, () => {
            fs.rmSync(wal);
            fs.writeFileSync(wal, "frame");
        });
        await writeUntilReported(stateChanged, () => fs.appendFileSync(wal, "frame"));
    }, 20_000);
});
