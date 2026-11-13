/**
 * Counts crashes of the Codex app-server in a sliding time window, overall and per key (a thread id).
 * The guard is tripped while the window holds `limit` crashes or more. It opens again on its own when the oldest of
 * those crashes leaves the window. The clock is injectable for tests.
 */
export class CrashLoopGuard {
    private readonly crashes = new Map<string, number[]>();

    constructor(
        readonly limit: number,
        readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    record(key = ""): void {
        const times = this.recent(key);
        times.push(this.now());
        this.crashes.set(key, times);
    }

    count(key = ""): number {
        return this.recent(key).length;
    }

    tripped(key = ""): boolean {
        return this.count(key) >= this.limit;
    }

    /** How long until the guard opens again, 0 when it is open. */
    retryAfterMs(key = ""): number {
        const times = this.recent(key);
        if (times.length < this.limit) return 0;
        // The guard opens when only `limit - 1` crashes are left in the window.
        const opening = times[times.length - this.limit]! + this.windowMs;
        return Math.max(0, opening - this.now());
    }

    /** The time of the last crash in the window, or null. */
    lastCrashAt(key = ""): number | null {
        return this.recent(key).at(-1) ?? null;
    }

    private recent(key: string): number[] {
        const since = this.now() - this.windowMs;
        const times = (this.crashes.get(key) ?? []).filter(time => time > since);
        if (times.length === 0) {
            this.crashes.delete(key);
        } else {
            this.crashes.set(key, times);
        }
        return times;
    }
}
