import type {MessageConnection} from "vscode-jsonrpc/node";

/** A wait for an app-server notification that ended because the connection to the app-server is gone. */
export class AppServerConnectionLostError extends Error {
    constructor(what: string) {
        super(`The connection to the Codex app-server was lost while waiting for ${what}.`);
        this.name = "AppServerConnectionLostError";
    }
}

/**
 * Tells the waits of one app-server connection that the connection is gone.
 *
 * vscode-jsonrpc rejects pending responses when the connection is disposed, but a wait for a notification
 * (`turn/completed`, a goal update, a login) has no response, so it would wait forever.
 * The exit of the Codex process disposes the connection and does not close it, so both events count.
 */
export class ConnectionLoss {
    private isLost = false;
    private readonly listeners = new Set<() => void>();

    constructor(connection: MessageConnection) {
        const lose = () => this.lose();
        connection.onClose?.(lose);
        connection.onDispose?.(lose);
    }

    get lost(): boolean {
        return this.isLost;
    }

    /**
     * Calls `listener` once when the connection is lost, at once when it is lost already.
     * Returns the function that removes the listener; callers remove it when their wait ends.
     */
    onLost(listener: () => void): () => void {
        if (this.isLost) {
            listener();
            return () => {};
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private lose(): void {
        if (this.isLost) return;
        this.isLost = true;
        const listeners = [...this.listeners];
        this.listeners.clear();
        for (const listener of listeners) listener();
    }
}
