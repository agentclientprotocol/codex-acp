import type {McpServerOauthLoginCompletedNotification} from "../app-server/v2";

type McpOauthCompletionWaiter = {
    threadId: string;
    match: (event: McpServerOauthLoginCompletedNotification) => void;
    reject: (error: unknown) => void;
};

/**
 * Routes the `mcpServer/oauthLogin/completed` notifications to the sign-ins that wait for them.
 * The server and thread can have several sign-ins in flight. Only the matching attempt can complete one.
 */
export class McpOauthCompletions {
    /** The waiters, by server name. */
    private readonly waiters = new Map<string, Set<McpOauthCompletionWaiter>>();
    private closedError: Error | null = null;

    complete(event: McpServerOauthLoginCompletedNotification): void {
        if (event.loginId == null) return;
        for (const waiter of [...this.waiters.get(event.name) ?? []]) {
            if (event.threadId === null || event.threadId === waiter.threadId) {
                waiter.match(event);
            }
        }
    }

    /** Register before starting login: a completion can arrive before the response that supplies its ID. */
    async await(
        name: string,
        threadId: string,
        loginId: Promise<string>,
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
                match: (event) => {
                    void loginId.then(id => {
                        if (event.loginId !== id) return;
                        release();
                        resolve(event);
                    }, () => {});
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
            void loginId.catch(waiter.reject);
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
