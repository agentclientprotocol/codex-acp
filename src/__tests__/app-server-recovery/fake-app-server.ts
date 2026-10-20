import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {vi} from "vitest";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {ResponseError, ErrorCodes, ConnectionError, ConnectionErrors} from "vscode-jsonrpc/node";
import type {CodexConnection} from "../../CodexJsonRpcConnection";

let nextPid = 1000;

/** A child process double: streams, pid, `kill()` and the `exit`/`close` events of a real child. */
export class FakeChild extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    pid: number | undefined = nextPid++;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    readonly signals: string[] = [];
    /** What the child does on SIGTERM: exit (default) or ignore it. */
    ignoreSigterm = false;

    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.signals.push(signal);
        if (signal === "SIGTERM" && this.ignoreSigterm) return true;
        this.die(null, signal);
        return true;
    }

    /** Exits like a real child: `exit`, then `close` once the pipes are closed. */
    die(code: number | null, signal: NodeJS.Signals | null = null): void {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
        this.stdout.end();
        setImmediate(() => this.emit("close", code, signal));
    }
}

interface PendingRequest {
    method: string;
    params: unknown;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
}

/**
 * A `MessageConnection` double with the dispose semantics of vscode-jsonrpc: `dispose()` fires `onDispose` and
 * rejects pending requests; later requests throw "Connection is disposed".
 */
export class FakeConnection {
    readonly pending: PendingRequest[] = [];
    readonly requests: Array<{method: string, params: unknown}> = [];
    disposed = false;
    private readonly disposeListeners = new Set<() => void>();
    private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
    private unhandledNotification: ((notification: unknown) => void) | null = null;
    readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
    /** Answers a request at once; `undefined` leaves it pending. */
    answer: (method: string, params: unknown) => unknown = () => ({});

    readonly connection = {
        sendRequest: (method: string, params?: unknown) => {
            if (this.disposed) {
                throw new ConnectionError(ConnectionErrors.Disposed, "Connection is disposed.");
            }
            this.requests.push({method, params});
            return new Promise((resolve, reject) => {
                const answer = this.answer(method, params);
                if (answer !== undefined) {
                    if (answer instanceof Error) reject(answer);
                    else resolve(answer);
                    return;
                }
                this.pending.push({method, params, resolve, reject});
            });
        },
        onUnhandledNotification: (handler: (notification: unknown) => void) => {
            this.unhandledNotification = handler;
        },
        onNotification: (method: string, handler: (params: unknown) => void) => {
            const listeners = this.notificationListeners.get(method) ?? new Set();
            listeners.add(handler);
            this.notificationListeners.set(method, listeners);
            return {dispose: () => listeners.delete(handler)};
        },
        onRequest: (type: {method: string}, handler: (params: unknown) => Promise<unknown>) => {
            this.requestHandlers.set(type.method, handler);
        },
        onDispose: (listener: () => void) => {
            this.disposeListeners.add(listener);
            return {dispose: () => this.disposeListeners.delete(listener)};
        },
        dispose: () => {
            if (this.disposed) return;
            this.disposed = true;
            [...this.disposeListeners].forEach(listener => listener());
            const error = new ResponseError(ErrorCodes.PendingResponseRejected, "Pending response rejected since connection got disposed");
            for (const request of this.pending.splice(0)) request.reject(error);
        },
        end: () => {},
        listen: () => {},
    } as unknown as MessageConnection;

    notify(notification: {method: string, params: unknown}): void {
        this.unhandledNotification?.(notification);
        for (const listener of this.notificationListeners.get(notification.method) ?? []) listener(notification.params);
    }

    /** Resolves the first pending request of `method`. */
    resolve(method: string, value: unknown): void {
        const index = this.pending.findIndex(request => request.method === method);
        if (index < 0) throw new Error(`No pending ${method}`);
        this.pending.splice(index, 1)[0]!.resolve(value);
    }

    hasPending(method: string): boolean {
        return this.pending.some(request => request.method === method);
    }
}

export interface FakeAppServer {
    child: FakeChild;
    rpc: FakeConnection;
    connection: CodexConnection;
}

export function fakeAppServer(configure?: (server: FakeAppServer) => void): FakeAppServer {
    const child = new FakeChild();
    const rpc = new FakeConnection();
    const server = {
        child,
        rpc,
        connection: {connection: rpc.connection, process: child as unknown as CodexConnection["process"]},
    };
    configure?.(server);
    return server;
}

/** A spawn function for the supervisor that hands out fake app-servers and records them. */
export function fakeSpawner(configure?: (server: FakeAppServer) => void) {
    const spawned: FakeAppServer[] = [];
    const spawn = vi.fn(() => {
        const server = fakeAppServer(configure);
        spawned.push(server);
        return server.connection;
    });
    return {spawned, spawn};
}
