import type {McpServerOauthLoginCompletedNotification} from "../app-server/v2";

type McpOauthCompletionWaiter = {
    threadId: string;
    resolve: (event: McpServerOauthLoginCompletedNotification) => void;
    reject: (error: unknown) => void;
};

/**
 * Routes the `mcpServer/oauthLogin/completed` notifications to the sign-ins that wait for them.
 * Many sign-ins can wait at the same time. One notification completes every waiter of its server and thread.
 */
export class McpOauthCompletions {
    /** The waiters, by server name. */
    private readonly waiters = new Map<string, Set<McpOauthCompletionWaiter>>();
    private closedError: Error | null = null;

    /** Completes the waiters of the server. A notification without a thread completes the waiters of every thread. */
    complete(event: McpServerOauthLoginCompletedNotification): void {
        for (const waiter of [...this.waiters.get(event.name) ?? []]) {
            if (event.threadId === null || event.threadId === waiter.threadId) {
                waiter.resolve(event);
            }
        }
    }

    /** Waits for the sign-in completion of the server. The wait rejects when `signal` aborts or when the Codex connection closes. */
    async await(
        name: string,
        threadId: string,
        signal?: AbortSignal,
    ): Promise<McpServerOauthLoginCompletedNotification> {
        signal?.throwIfAborted();
        if (this.closedError !== null) {
            throw this.closedError;
        }
        return await new Promise((resolve, reject) => {
            const onAbort = () => waiter.reject(signal?.reason);
            const release = () => {
                const waiters = this.waiters.get(name);
                waiters?.delete(waiter);
                if (waiters?.size === 0) {
                    this.waiters.delete(name);
                }
                signal?.removeEventListener("abort", onAbort);
            };
            const waiter: McpOauthCompletionWaiter = {
                threadId,
                resolve: (event) => {
                    release();
                    resolve(event);
                },
                reject: (error) => {
                    release();
                    reject(error);
                },
            };
            signal?.addEventListener("abort", onAbort, {once: true});
            let waiters = this.waiters.get(name);
            if (waiters === undefined) {
                waiters = new Set();
                this.waiters.set(name, waiters);
            }
            waiters.add(waiter);
        });
    }

    /** Rejects every wait, now and later, because the Codex connection closed. */
    dispose(): void {
        this.closedError ??= new Error("Codex connection closed during the MCP server sign-in.");
        for (const waiters of [...this.waiters.values()]) {
            for (const waiter of [...waiters]) {
                waiter.reject(this.closedError);
            }
        }
    }
}
