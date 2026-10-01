import type {
    McpServerStartupFailureReason,
    McpServerStartupState,
    McpServerStatusUpdatedNotification,
} from "../app-server/v2";

export type McpStartupFailure = {
    server: string;
    error: string;
    failureReason?: McpServerStartupFailureReason;
};

export type McpStartupResult = {
    ready: Array<string>;
    failed: Array<McpStartupFailure>;
    cancelled: Array<string>;
};

export type McpServerStartupWaitOptions = {
    /** The thread whose startup events count. The global events also count. */
    threadId: string;
    signal?: AbortSignal;
};

type McpServerStartupSnapshot = {
    status: McpServerStartupState;
    error: string | null;
    failureReason: McpServerStartupFailureReason | null;
    version: number;
};

type McpServerStartupWaiter = {
    serverNames: Array<string>;
    afterVersion: number;
    threadId: string;
    resolve: (result: McpStartupResult) => void;
    reject: (error: unknown) => void;
};

/**
 * Tracks the MCP server startup events of one Codex connection.
 * Each event increments the version, so a caller can wait for the events that come after a version.
 */
export class McpStartupTracker {
    private currentVersion = 0;
    /** The last startup state of each MCP server, by server name and then by thread id. A `null` thread id is global. */
    private readonly states = new Map<string, Map<string | null, McpServerStartupSnapshot>>();
    private readonly waiters: Array<McpServerStartupWaiter> = [];
    private closedError: Error | null = null;

    /** Returns the version of the last startup event. */
    version(): number {
        return this.currentVersion;
    }

    record(params: McpServerStatusUpdatedNotification): void {
        this.currentVersion += 1;
        let states = this.states.get(params.name);
        if (states === undefined) {
            states = new Map();
            this.states.set(params.name, states);
        }
        states.set(params.threadId, {
            status: params.status,
            error: params.error,
            failureReason: params.failureReason ?? null,
            version: this.currentVersion,
        });
        for (const waiter of [...this.waiters]) {
            const result = this.tryBuildResult(waiter.serverNames, waiter.afterVersion, waiter.threadId);
            if (result !== null) {
                waiter.resolve(result);
            }
        }
    }

    /**
     * Waits until each server reaches a terminal startup state after `afterVersion`.
     * Only the events of `threadId` and the global events count.
     * The wait rejects when `signal` aborts or when the Codex connection closes.
     */
    async await(
        serverNames: Array<string>,
        afterVersion: number,
        options: McpServerStartupWaitOptions,
    ): Promise<McpStartupResult> {
        const uniqueServerNames = Array.from(new Set(serverNames.map(name => name.trim()).filter(name => name.length > 0)));
        if (uniqueServerNames.length === 0) {
            return {ready: [], failed: [], cancelled: []};
        }
        const {threadId, signal} = options;
        const result = this.tryBuildResult(uniqueServerNames, afterVersion, threadId);
        if (result !== null) {
            return result;
        }
        signal?.throwIfAborted();
        if (this.closedError !== null) {
            throw this.closedError;
        }

        return await new Promise((resolve, reject) => {
            const onAbort = () => waiter.reject(signal?.reason);
            const release = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) {
                    this.waiters.splice(index, 1);
                }
                signal?.removeEventListener("abort", onAbort);
            };
            const waiter: McpServerStartupWaiter = {
                serverNames: uniqueServerNames,
                afterVersion,
                threadId,
                resolve: (startup) => {
                    release();
                    resolve(startup);
                },
                reject: (error) => {
                    release();
                    reject(error);
                },
            };
            signal?.addEventListener("abort", onAbort, {once: true});
            this.waiters.push(waiter);
        });
    }

    /** Drops the startup states of a thread. The global states stay. */
    forgetThread(threadId: string): void {
        for (const [serverName, states] of this.states) {
            states.delete(threadId);
            if (states.size === 0) {
                this.states.delete(serverName);
            }
        }
    }

    /** Rejects every wait, now and later, because the Codex connection closed. */
    dispose(): void {
        this.closedError ??= new Error("Codex connection closed during the MCP server startup.");
        for (const waiter of [...this.waiters]) {
            waiter.reject(this.closedError);
        }
    }

    /** Returns the latest startup state of the server for the thread. A global state also counts. */
    private latestState(serverName: string, threadId: string): McpServerStartupSnapshot | undefined {
        let latest: McpServerStartupSnapshot | undefined;
        for (const [stateThreadId, state] of this.states.get(serverName) ?? []) {
            if (stateThreadId !== null && stateThreadId !== threadId) {
                continue;
            }
            if (latest === undefined || state.version > latest.version) {
                latest = state;
            }
        }
        return latest;
    }

    private tryBuildResult(serverNames: Array<string>, afterVersion: number, threadId: string): McpStartupResult | null {
        const ready: Array<string> = [];
        const failed: Array<McpStartupFailure> = [];
        const cancelled: Array<string> = [];

        for (const serverName of serverNames) {
            const state = this.latestState(serverName, threadId);
            if (!state || state.version <= afterVersion) {
                return null;
            }

            switch (state.status) {
                case "starting":
                    return null;
                case "ready":
                    ready.push(serverName);
                    break;
                case "failed":
                    failed.push({
                        server: serverName,
                        error: state.error ?? "unknown MCP startup error",
                        ...(state.failureReason === null ? {} : {failureReason: state.failureReason}),
                    });
                    break;
                case "cancelled":
                    cancelled.push(serverName);
                    break;
            }
        }

        return {ready, failed, cancelled};
    }
}
