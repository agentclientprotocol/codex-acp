/**
 * Sends `_session/list_changed` when the first page of a session list that
 * the client read lately changes.
 *
 * Codex keeps its thread index in `<CODEX_HOME>/state_<n>.sqlite`, in WAL
 * mode, so every change of a thread by any Codex process writes the
 * `state_<n>.sqlite-wal` file. A read does not write it. The watcher listens
 * for those writes with `fs.watch` of each WAL file and a non-recursive
 * `fs.watch` of CODEX_HOME, which sees a WAL file appear or go. On macOS
 * only the watch of the file itself reports a write. The watcher also
 * listens for the thread notifications of its own app-server, and checks
 * the WAL size and time every 30 s in case the file system drops an event. Each of them only schedules a check. The
 * check reads page 1 of each watched list again and notifies only the lists
 * whose page changed.
 *
 * A lost notification is acceptable: the client also polls page 1.
 */

import fs from "node:fs";
import path from "node:path";
import {logger} from "./Logger";
import type {SessionIndexListOptions} from "./SessionIndex";

export interface SessionListChangedTimings {
    /** The quiet time after the last event before a check. */
    debounceMs: number;
    /** The longest time between the first event and its check. */
    maxWaitMs: number;
    /** How long a list stays watched after the client read it. */
    watchTtlMs: number;
    /** How often the WAL size and time are checked without an event. */
    fallbackIntervalMs: number;
}

export const DEFAULT_SESSION_LIST_CHANGED_TIMINGS: SessionListChangedTimings = {
    debounceMs: 1_000,
    maxWaitMs: 2_000,
    watchTtlMs: 10 * 60_000,
    fallbackIntervalMs: 30_000,
};

/** The most lists one connection watches. The least recently read list goes first. */
export const MAX_WATCHED_SESSION_LISTS = 32;

const STATE_DB_WAL_PATTERN = /^state_\d+\.sqlite-wal$/;

export interface WatchedSessionList {
    cwd: string;
    options: SessionIndexListOptions;
}

export interface SessionListChangedWatcherDeps {
    /** CODEX_HOME, or `null` when the app-server did not report it. Then only own notifications trigger a check. */
    codexHome: () => string | null;
    /** The signature of page 1 of a list now, see `sessionIndexPageSignature`. */
    readSignature: (list: WatchedSessionList) => Promise<string>;
    notify: (cwd: string) => Promise<void>;
    timings?: SessionListChangedTimings;
    now?: () => number;
}

/** The watch of one WAL file. `fs.watch` of a file follows its inode, not its name. */
interface WalWatch {
    watcher: fs.FSWatcher;
    ino: number;
}

interface WatchEntry extends WatchedSessionList {
    signature: string;
    lastRequestedAt: number;
}

export class SessionListChangedWatcher {
    private readonly entries = new Map<string, WatchEntry>();
    private readonly timings: SessionListChangedTimings;
    private readonly now: () => number;
    private fsWatcher: fs.FSWatcher | null = null;
    private readonly walWatchers = new Map<string, WalWatch>();
    private watchedHome: string | null = null;
    private fallbackTimer: ReturnType<typeof setInterval> | null = null;
    private walSnapshot: string | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private firstPendingEventAt: number | null = null;
    private checking: Promise<void> | null = null;
    private checkAgain = false;
    private disposed = false;

    constructor(private readonly deps: SessionListChangedWatcherDeps) {
        this.timings = deps.timings ?? DEFAULT_SESSION_LIST_CHANGED_TIMINGS;
        this.now = deps.now ?? Date.now;
    }

    /**
     * Records that the client read page 1 of a list, with the signature of the page it got.
     * The list is then watched for {@link SessionListChangedTimings.watchTtlMs}.
     */
    observeList(list: WatchedSessionList, signature: string): void {
        if (this.disposed) return;
        const key = watchKey(list);
        this.entries.delete(key);
        this.entries.set(key, {...list, signature, lastRequestedAt: this.now()});
        while (this.entries.size > MAX_WATCHED_SESSION_LISTS) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        this.ensureWatching();
    }

    /** Something may have changed a list: check the watched lists after the debounce. */
    trigger(): void {
        if (this.disposed || this.entries.size === 0) return;
        const now = this.now();
        this.firstPendingEventAt ??= now;
        const wait = Math.max(0, Math.min(this.timings.debounceMs, this.firstPendingEventAt + this.timings.maxWaitMs - now));
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.firstPendingEventAt = null;
            void this.check();
        }, wait);
        this.debounceTimer.unref?.();
    }

    /** Reads page 1 of each watched list and notifies the lists that changed. Never rejects. */
    async check(): Promise<void> {
        if (this.checking !== null) {
            this.checkAgain = true;
            return await this.checking;
        }
        const run = this.runChecks().finally(() => {
            this.checking = null;
            if (this.checkAgain) {
                this.checkAgain = false;
                void this.check();
            }
        });
        this.checking = run;
        return await run;
    }

    dispose(): void {
        this.disposed = true;
        this.entries.clear();
        this.stopWatching();
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
    }

    /** The lists that are watched now. For tests and logs. */
    watchedLists(): WatchedSessionList[] {
        this.dropExpired();
        return [...this.entries.values()].map(({cwd, options}) => ({cwd, options}));
    }

    private async runChecks(): Promise<void> {
        this.dropExpired();
        if (this.entries.size === 0) {
            this.stopWatching();
            return;
        }
        const changedCwds = new Set<string>();
        for (const [key, entry] of [...this.entries]) {
            let signature: string;
            try {
                signature = await this.deps.readSignature(entry);
            } catch (error) {
                logger.log("Session list check failed", {cwd: entry.cwd, error: String(error)});
                continue;
            }
            const current = this.entries.get(key);
            if (current === undefined || current.signature === signature) continue;
            current.signature = signature;
            changedCwds.add(entry.cwd);
        }
        for (const cwd of changedCwds) {
            if (this.disposed) return;
            try {
                await this.deps.notify(cwd);
            } catch (error) {
                logger.log("Failed to send session list change", {cwd, error: String(error)});
            }
        }
    }

    private dropExpired(): void {
        const cutoff = this.now() - this.timings.watchTtlMs;
        for (const [key, entry] of this.entries) {
            if (entry.lastRequestedAt < cutoff) this.entries.delete(key);
        }
    }

    private ensureWatching(): void {
        const home = this.deps.codexHome();
        if (this.fallbackTimer === null) {
            this.fallbackTimer = setInterval(() => this.pollWal(), this.timings.fallbackIntervalMs);
            this.fallbackTimer.unref?.();
        }
        if (home === null || (this.fsWatcher !== null && this.watchedHome === home)) return;
        this.closeFsWatcher();
        this.watchedHome = home;
        this.walSnapshot = readWalSnapshot(home);
        this.refreshWalWatchers(home);
        try {
            this.fsWatcher = fs.watch(home, {persistent: false}, (_event, filename) => {
                const name = filename === null ? null : filename.toString();
                if (name === null || STATE_DB_WAL_PATTERN.test(name)) {
                    this.refreshWalWatchers(home);
                    this.trigger();
                }
            });
            this.fsWatcher.on("error", (error) => {
                logger.log("CODEX_HOME watch failed; the 30 s check remains", {error: String(error)});
                this.closeFsWatcher();
            });
        } catch (error) {
            logger.log("Cannot watch CODEX_HOME; the 30 s check remains", {home, error: String(error)});
            this.fsWatcher = null;
        }
    }

    private pollWal(): void {
        this.dropExpired();
        if (this.entries.size === 0) {
            this.stopWatching();
            return;
        }
        const home = this.watchedHome ?? this.deps.codexHome();
        if (home === null) return;
        this.refreshWalWatchers(home);
        const snapshot = readWalSnapshot(home);
        if (snapshot !== this.walSnapshot) {
            this.walSnapshot = snapshot;
            this.trigger();
        }
    }

    private stopWatching(): void {
        this.closeFsWatcher();
        if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
        this.fallbackTimer = null;
    }

    /**
     * Watches each state DB WAL in CODEX_HOME, and stops watching the ones that are gone. SQLite deletes the
     * WAL when the last connection closes and creates a new file later. A watch of the old file sees none of
     * the writes to the new one, so a WAL whose inode changed is watched again.
     */
    private refreshWalWatchers(home: string): void {
        if (this.disposed) return;
        const inodes = new Map<string, number>();
        for (const name of listWalFiles(home)) {
            const ino = inodeOf(path.join(home, name));
            if (ino !== null) inodes.set(name, ino);
        }
        for (const [name, watch] of this.walWatchers) {
            if (inodes.get(name) !== watch.ino) this.dropWalWatcher(name, watch);
        }
        for (const [name, ino] of inodes) {
            if (this.walWatchers.has(name)) continue;
            try {
                const watcher = fs.watch(path.join(home, name), {persistent: false}, (event) => {
                    if (event === "rename") {
                        // The file was deleted or replaced: this watch sees no more writes.
                        this.dropWalWatcher(name, watch);
                        this.refreshWalWatchers(home);
                    }
                    this.trigger();
                });
                const watch: WalWatch = {watcher, ino};
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

    private closeFsWatcher(): void {
        this.fsWatcher?.close();
        this.fsWatcher = null;
        for (const watch of this.walWatchers.values()) watch.watcher.close();
        this.walWatchers.clear();
        this.watchedHome = null;
    }
}

function watchKey(list: WatchedSessionList): string {
    return `${list.options.archived}\u0000${list.options.limit}\u0000${list.cwd}`;
}

/** The size and modification time of every state DB WAL in CODEX_HOME. */
function readWalSnapshot(home: string): string {
    return listWalFiles(home).map(name => {
        try {
            const stats = fs.statSync(path.join(home, name));
            return `${name}:${stats.size}:${stats.mtimeMs}`;
        } catch {
            return `${name}:-`;
        }
    }).join("|");
}

function inodeOf(file: string): number | null {
    try {
        return fs.statSync(file).ino;
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
