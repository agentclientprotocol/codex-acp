/**
 * Watches CODEX_HOME for the writes of any Codex process that can change the session list.
 *
 * Codex keeps its thread index in `<CODEX_HOME>/state_<n>.sqlite`, in WAL mode, so every change of a thread by
 * any Codex process writes the `state_<n>.sqlite-wal` file. A read does not write it. The watcher listens for
 * those writes with `fs.watch` of each WAL file and a non-recursive `fs.watch` of CODEX_HOME, which sees a WAL
 * file appear or go. On macOS only the watch of the file itself reports a write. It also checks the WAL size
 * and time every 30 s in case the file system drops an event.
 *
 * Codex moves the rollout of an archived thread into `<CODEX_HOME>/archived_sessions/` and back on unarchive,
 * without moving the `updated_at` of the thread. A non-recursive watch of that directory reports the id of each
 * rollout that appears or goes there. A rename does not move `updated_at` either; it appends to
 * `<CODEX_HOME>/session_index.jsonl`, whose writes count as a change of the state as well.
 *
 * The watcher only reports; the caller debounces and reads.
 */

import fs from "node:fs";
import path from "node:path";
import {logger} from "./Logger";
import {SESSION_NAME_LOG_FILE} from "./SessionNameLog";

export const ARCHIVED_SESSIONS_DIR = "archived_sessions";

const STATE_DB_WAL_PATTERN = /^state_\d+\.sqlite-wal$/;
/** The thread id at the end of a rollout file name: `rollout-<time>-<uuid>.jsonl`. */
const ROLLOUT_THREAD_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexHomeWatcherListener {
    /** A state DB WAL was written, appeared or went. */
    stateChanged(): void;
    /** The rollout of a thread appeared in or went from `archived_sessions`. */
    archiveMoved(threadId: string): void;
}

/** The watch of one WAL file. `fs.watch` of a file follows the file, not its name. */
interface WalWatch {
    watcher: fs.FSWatcher;
    /** See {@link fileIdentityOf}. */
    identity: string;
}

export class CodexHomeWatcher {
    private homeWatcher: fs.FSWatcher | null = null;
    private archiveWatcher: fs.FSWatcher | null = null;
    private nameLogWatcher: fs.FSWatcher | null = null;
    private readonly walWatchers = new Map<string, WalWatch>();
    private fallbackTimer: ReturnType<typeof setInterval> | null = null;
    private walSnapshot: string;
    private stopped = false;

    /**
     * Starts watching at once.
     *
     * @param fallbackIntervalMs how often the WAL size and time are checked without an event.
     */
    constructor(
        private readonly home: string,
        private readonly listener: CodexHomeWatcherListener,
        fallbackIntervalMs: number,
    ) {
        this.walSnapshot = readWalSnapshot(home);
        this.refreshWalWatchers();
        this.watchHome();
        this.watchArchive();
        this.watchNameLog();
        this.fallbackTimer = setInterval(() => this.pollWal(), fallbackIntervalMs);
        this.fallbackTimer.unref?.();
    }

    /** Closes every watch and the fallback check. */
    stop(): void {
        this.stopped = true;
        if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
        this.fallbackTimer = null;
        this.homeWatcher?.close();
        this.homeWatcher = null;
        this.archiveWatcher?.close();
        this.archiveWatcher = null;
        this.nameLogWatcher?.close();
        this.nameLogWatcher = null;
        for (const watch of this.walWatchers.values()) watch.watcher.close();
        this.walWatchers.clear();
    }

    private stateChanged(): void {
        if (!this.stopped) this.listener.stateChanged();
    }

    private watchHome(): void {
        try {
            this.homeWatcher = fs.watch(this.home, {persistent: false}, (event, filename) => {
                const name = filename === null ? null : filename.toString();
                if (name === null || STATE_DB_WAL_PATTERN.test(name)) {
                    // Linux reports every write here too; only a WAL that appears or goes needs new watches.
                    if (event === "rename") this.refreshWalWatchers();
                    this.stateChanged();
                }
                if (name === null || name === SESSION_NAME_LOG_FILE) {
                    if (event === "rename") this.watchNameLog();
                    this.stateChanged();
                }
                // Codex creates `archived_sessions` on the first archive.
                if ((name === null || name === ARCHIVED_SESSIONS_DIR) && this.archiveWatcher === null) {
                    this.watchArchive();
                }
            });
            this.homeWatcher.on("error", (error) => {
                logger.log("CODEX_HOME watch failed; the 30 s check remains", {error: String(error)});
                this.homeWatcher?.close();
                this.homeWatcher = null;
            });
        } catch (error) {
            logger.log("Cannot watch CODEX_HOME; the 30 s check remains", {home: this.home, error: String(error)});
            this.homeWatcher = null;
        }
    }

    private watchArchive(): void {
        if (this.stopped) return;
        const dir = path.join(this.home, ARCHIVED_SESSIONS_DIR);
        if (!fs.existsSync(dir)) return;
        try {
            const watcher = fs.watch(dir, {persistent: false}, (_event, filename) => {
                const threadId = filename === null ? null : ROLLOUT_THREAD_ID_PATTERN.exec(filename.toString())?.[1];
                if (threadId && !this.stopped) this.listener.archiveMoved(threadId.toLowerCase());
            });
            watcher.on("error", () => {
                watcher.close();
                if (this.archiveWatcher === watcher) this.archiveWatcher = null;
            });
            this.archiveWatcher = watcher;
        } catch (error) {
            logger.log("Cannot watch archived_sessions", {dir, error: String(error)});
        }
    }

    /** Watches the session name log itself: on macOS the watch of CODEX_HOME does not report writes to it. */
    private watchNameLog(): void {
        if (this.stopped) return;
        this.nameLogWatcher?.close();
        this.nameLogWatcher = null;
        const file = path.join(this.home, SESSION_NAME_LOG_FILE);
        if (!fs.existsSync(file)) return;
        try {
            const watcher = fs.watch(file, {persistent: false}, (event) => {
                // A log that Codex writes anew is another file, which this watch does not follow.
                if (event === "rename") this.watchNameLog();
                this.stateChanged();
            });
            watcher.on("error", () => {
                watcher.close();
                if (this.nameLogWatcher === watcher) this.nameLogWatcher = null;
            });
            this.nameLogWatcher = watcher;
        } catch (error) {
            logger.log("Cannot watch the session name log", {file, error: String(error)});
        }
    }

    private pollWal(): void {
        if (this.stopped) return;
        this.refreshWalWatchers();
        if (this.archiveWatcher === null) this.watchArchive();
        if (this.nameLogWatcher === null) this.watchNameLog();
        const snapshot = readWalSnapshot(this.home);
        if (snapshot !== this.walSnapshot) {
            this.walSnapshot = snapshot;
            this.stateChanged();
        }
    }

    /**
     * Watches each state DB WAL in CODEX_HOME, and stops watching the ones that are gone. SQLite deletes the
     * WAL when the last connection closes and creates a new file later. A watch of the old file sees none of
     * the writes to the new one, so a WAL that is another file now is watched again.
     */
    private refreshWalWatchers(): void {
        if (this.stopped) return;
        const home = this.home;
        const identities = new Map<string, string>();
        for (const name of listWalFiles(home)) {
            const identity = fileIdentityOf(path.join(home, name));
            if (identity !== null) identities.set(name, identity);
        }
        for (const [name, watch] of this.walWatchers) {
            if (identities.get(name) !== watch.identity) this.dropWalWatcher(name, watch);
        }
        for (const [name, identity] of identities) {
            if (this.walWatchers.has(name)) continue;
            try {
                const watcher = fs.watch(path.join(home, name), {persistent: false}, (event) => {
                    // A file that is gone or replaced needs a new watch: this one sees no more of its writes.
                    // Elsewhere "rename" means just that, even when Linux gives the new file the same inode.
                    // macOS also reports a write in place as "rename", so there only another file counts.
                    if (event === "rename" && (process.platform !== "darwin"
                        || fileIdentityOf(path.join(home, name)) !== watch.identity)) {
                        this.dropWalWatcher(name, watch);
                        this.refreshWalWatchers();
                    }
                    this.stateChanged();
                });
                const watch: WalWatch = {watcher, identity};
                watcher.on("error", () => this.dropWalWatcher(name, watch));
                this.walWatchers.set(name, watch);
            } catch (error) {
                logger.log("Cannot watch the state DB WAL; the 30 s check remains", {name, error: String(error)});
            }
        }
    }

    private dropWalWatcher(name: string, watch: WalWatch): void {
        watch.watcher.close();
        if (this.walWatchers.get(name) === watch) this.walWatchers.delete(name);
    }
}

/** The size and modification time of every state DB WAL in CODEX_HOME and of the session name log. */
function readWalSnapshot(home: string): string {
    return [...listWalFiles(home), SESSION_NAME_LOG_FILE].map(name => {
        try {
            const stats = fs.statSync(path.join(home, name));
            return `${name}:${stats.size}:${stats.mtimeMs}`;
        } catch {
            return `${name}:-`;
        }
    }).join("|");
}

/**
 * What tells a file from another one under the same name. On macOS that is the inode and the creation time,
 * which stays as the file is written. Elsewhere it is the inode alone: without `statx`, libuv reports the
 * change time as the creation time, so every write would look like another file. A file that Linux creates
 * with the inode of a deleted one is caught by the "rename" event of the watch of the deleted file instead.
 */
function fileIdentityOf(file: string): string | null {
    try {
        const stats = fs.statSync(file);
        return process.platform === "darwin"
            ? `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
            : `${stats.dev}:${stats.ino}`;
    } catch {
        return null;
    }
}

function listWalFiles(home: string): string[] {
    try {
        return fs.readdirSync(home).filter(name => STATE_DB_WAL_PATTERN.test(name)).sort();
    } catch {
        return [];
    }
}
