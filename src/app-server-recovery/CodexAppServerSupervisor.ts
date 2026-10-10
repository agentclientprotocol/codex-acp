import type {CodexConnection} from "../CodexJsonRpcConnection";
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {logger} from "../Logger";
import {type AppServerExit, describeExit, likelyOutOfMemory} from "./AppServerExit";

/** The part of `CodexProcessState` that the supervisor owns. */
export interface SupervisedProcessState {
    connection: CodexConnection;
    codexPath: string | undefined;
    /** The arguments the app-server starts with, such as the hook trust override; `app-server` alone when unset. */
    appServerStartupArgs?: string[];
    stderr: string;
}

/** One Codex app-server child and its connection. */
export interface SupervisedChild {
    readonly generation: number;
    readonly connection: CodexConnection;
    readonly startedAt: number;
    /** Set once the child is gone and its connection is disposed. */
    exit: AppServerExit | null;
    /**
     * True from the moment the exit is seen. The connection still delivers the output that the child wrote before it
     * died, but no new request may start on it.
     */
    dead: boolean;
    /** The adapter stops the child on purpose: its exit is not a crash. */
    intentional: boolean;
    /**
     * The adapter stops the child because it failed (a handshake timeout): its exit stays a crash, also when a later
     * {@link CodexAppServerSupervisor.stop} waits for it.
     */
    failing: boolean;
    /** Settles with the exit once the connection is disposed. Never rejects. */
    readonly exited: Promise<AppServerExit>;
    /** Starts the stop sequence of this child. Internal to the supervisor. */
    terminate: () => void;
}

export interface SupervisorTimings {
    /** After `exit`, how long to wait for the child's `close` (its output read to the end). */
    closeGraceMs: number;
    /** After `close`, how long the JSON-RPC connection gets to handle the messages it has read. */
    drainMs: number;
    /** After the end of stdin, when a child that does not exit gets SIGTERM. */
    terminateAfterMs: number;
    /** After SIGTERM, when the supervisor stops waiting and closes its ends of the pipes. */
    abandonAfterMs: number;
    /** After stdout ended while the child still runs, when the child is stopped. */
    wedgedAfterMs: number;
}

const DEFAULT_TIMINGS: SupervisorTimings = {
    closeGraceMs: 1_000,
    drainMs: 50,
    terminateAfterMs: 2_000,
    abandonAfterMs: 5_000,
    wedgedAfterMs: 5_000,
};

export type ExitListener = (exit: AppServerExit, child: SupervisedChild) => void;

/** At most this many exits are kept for the error messages of late failures. */
const KEPT_EXITS = 16;

/**
 * Owns the lifecycle of the Codex app-server child: spawn, exit detection, intentional stops and shutdown.
 *
 * An exit is detected from the child's `exit` event, from a spawn `error` without a pid (Node may then never emit
 * `exit`), and from stdout ending while the child still runs. The supervisor disposes the connection itself, after the
 * output that the child wrote before it died was read, so a `turn/completed` that made it to the pipe is not lost.
 *
 * It never sends SIGKILL: the bundled `codex.js` wrapper forwards SIGTERM to the native binary but cannot forward
 * SIGKILL, and the native binary inherits the pipes. Closing our ends of the pipes makes an orphaned native binary
 * see the end of its stdin and exit.
 */
export class CodexAppServerSupervisor {
    private child: SupervisedChild;
    private nextGeneration = 1;
    private isShuttingDown = false;
    private readonly exitListeners = new Set<ExitListener>();
    private readonly deathListeners = new Set<(child: SupervisedChild) => void>();
    private readonly exits = new Map<number, AppServerExit>();
    private readonly timings: SupervisorTimings;

    constructor(
        private readonly state: SupervisedProcessState,
        private readonly spawnConnection: (codexPath: string | undefined, appServerStartupArgs?: string[]) => CodexConnection =
            (codexPath, appServerStartupArgs) =>
                startCodexConnection(codexPath, undefined, appServerStartupArgs, {disposeOnExit: false}),
        timings: Partial<SupervisorTimings> = {},
        private readonly now: () => number = Date.now,
    ) {
        this.timings = {...DEFAULT_TIMINGS, ...timings};
        this.child = this.watch(state.connection);
    }

    get current(): SupervisedChild {
        return this.child;
    }

    get generation(): number {
        return this.child.generation;
    }

    get shuttingDown(): boolean {
        return this.isShuttingDown;
    }

    /** True while the child of `generation` (default: the current one) runs and the agent is not shutting down. */
    isAlive(generation = this.child.generation): boolean {
        return generation === this.child.generation && !this.child.dead && !this.isShuttingDown;
    }

    /** The exit of `generation`, while it is among the last kept exits. */
    exitOf(generation: number): AppServerExit | undefined {
        return this.exits.get(generation);
    }

    /** The most recent exit, or undefined. */
    get lastExit(): AppServerExit | undefined {
        let last: AppServerExit | undefined;
        for (const exit of this.exits.values()) last = exit;
        return last;
    }

    /**
     * Calls `listener` for every exit, right before the connection of the child is disposed: pending requests of the
     * child are still pending, and their error mapping can already see the exit. Listeners must not throw.
     */
    onExit(listener: ExitListener): () => void {
        this.exitListeners.add(listener);
        return () => {
            this.exitListeners.delete(listener);
        };
    }

    /**
     * Calls `listener` at the moment a child is seen dead, before its output drains and before {@link onExit}.
     * Listeners must not throw.
     */
    onDeath(listener: (child: SupervisedChild) => void): () => void {
        this.deathListeners.add(listener);
        return () => {
            this.deathListeners.delete(listener);
        };
    }

    /** Starts a new child. The current child must be gone. */
    spawn(): SupervisedChild {
        if (this.isShuttingDown) throw new Error("The agent is shutting down");
        if (this.child.exit === null) throw new Error("The Codex app-server is still running or draining");
        this.state.stderr = "";
        const connection = this.spawnConnection(this.state.codexPath, this.state.appServerStartupArgs);
        this.state.connection = connection;
        this.child = this.watch(connection);
        logger.log("[APP-SERVER START]", {generation: this.child.generation, pid: connection.process.pid ?? null});
        return this.child;
    }

    /**
     * Stops `child` on purpose (a provider restart): end of stdin, SIGTERM after a grace time, and if it still does not
     * exit, the supervisor closes its ends of the pipes and stops waiting. Resolves once the child counts as gone.
     */
    async stop(child: SupervisedChild = this.child): Promise<AppServerExit> {
        // A child that died on its own, or that is stopped because it failed, stays a crash.
        if (!child.dead) {
            if (!child.failing) child.intentional = true;
            this.terminate(child);
        }
        return await child.exited;
    }

    /** The ACP client is gone: stop the child and never start another one. */
    shutdown(): void {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        logger.log("[APP-SERVER SHUTDOWN]", {generation: this.child.generation});
        void this.stop(this.child);
    }

    private watch(connection: CodexConnection): SupervisedChild {
        const process = connection.process;
        const generation = this.nextGeneration++;
        let resolveExited: (exit: AppServerExit) => void = () => {};
        const exited = new Promise<AppServerExit>(resolve => {
            resolveExited = resolve;
        });
        const child: SupervisedChild = {
            generation,
            connection,
            startedAt: this.now(),
            exit: null,
            dead: false,
            intentional: false,
            failing: false,
            exited,
            terminate: () => {},
        };
        let exitSeen = false;
        let finalized = false;
        let closed = false;
        let stdoutEnded = false;
        let wedgedTimer: ReturnType<typeof setTimeout> | null = null;

        const markDead = () => {
            child.dead = true;
            for (const listener of [...this.deathListeners]) {
                try {
                    listener(child);
                } catch (error) {
                    logger.error("App-server death listener failed", error);
                }
            }
        };
        const finalize = (exit: AppServerExit) => {
            if (finalized) return;
            finalized = true;
            if (wedgedTimer !== null) clearTimeout(wedgedTimer);
            child.exit = exit;
            for (const listener of [...this.exitListeners]) {
                try {
                    listener(exit, child);
                } catch (error) {
                    logger.error("App-server exit listener failed", error);
                }
            }
            destroyPipes(connection);
            connection.connection.dispose();
            resolveExited(exit);
        };

        const record = (code: number | null, signal: NodeJS.Signals | null, error?: string): AppServerExit => {
            const exit: AppServerExit = {
                generation,
                pid: process.pid,
                code,
                signal,
                ...(error !== undefined ? {error} : {}),
                intentional: child.intentional,
                at: this.now(),
                uptimeMs: this.now() - child.startedAt,
                stderrTail: this.state.connection === connection ? this.state.stderr : "",
            };
            // Known at once, also while the connection still drains, for the errors of requests that fail now.
            this.exits.set(generation, exit);
            while (this.exits.size > KEPT_EXITS) {
                this.exits.delete(this.exits.keys().next().value!);
            }
            const fields = {
                generation,
                pid: exit.pid ?? null,
                code,
                signal,
                uptimeMs: exit.uptimeMs,
                intentional: exit.intentional,
                ...(error !== undefined ? {error} : {}),
            };
            if (exit.intentional) {
                logger.log("[APP-SERVER EXIT] stopped by the adapter", fields);
            } else {
                logger.error(`[APP-SERVER EXIT] The Codex app-server ${describeExit(exit)}`, JSON.stringify({
                    ...fields,
                    likelyOutOfMemory: likelyOutOfMemory(exit),
                    stderrTail: exit.stderrTail,
                }));
            }
            return exit;
        };

        process.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            if (exitSeen) return;
            exitSeen = true;
            markDead();
            const exit = record(code, signal);
            // Read what the child wrote before it died. A real connection says when it handled the last message.
            // A grandchild that inherited the pipes can hold stdout open, so wait at most `closeGraceMs`.
            if (connection.drained !== undefined) {
                // Once stdout ended, the marker is queued behind the last message and runs: wait for it however long
                // the backlog takes. Only a stdout that a grandchild holds open is bounded.
                let grace: ReturnType<typeof setTimeout> | undefined;
                const bound = () => {
                    grace = setTimeout(() => finalize(exit), this.timings.closeGraceMs);
                };
                if (!stdoutEnded) bound();
                const unbound = () => clearTimeout(grace);
                process.stdout?.once("end", unbound);
                void connection.drained.then(() => {
                    clearTimeout(grace);
                    process.stdout?.off("end", unbound);
                    finalize(exit);
                });
                return;
            }
            // Without that signal: wait for `close`, then give the connection a moment to handle what it has read.
            if (closed || !process.stdout) {
                setTimeout(() => finalize(exit), closed ? this.timings.drainMs : 0);
                return;
            }
            const grace = setTimeout(() => finalize(exit), this.timings.closeGraceMs);
            process.once("close", () => {
                clearTimeout(grace);
                setTimeout(() => finalize(exit), this.timings.drainMs);
            });
        });
        process.on("close", () => {
            closed = true;
        });
        process.on("error", (error: Error) => {
            if (process.pid !== undefined) {
                logger.log(`[APP-SERVER ERROR] ${error.message}`, {generation});
                return;
            }
            // The child never started (ENOENT, EACCES). Node may not emit `exit` then.
            if (exitSeen) return;
            exitSeen = true;
            markDead();
            finalize(record(null, null, error.message));
        });
        process.stdout?.on("end", () => {
            stdoutEnded = true;
            if (exitSeen) return;
            // The child closed its protocol stream but runs on: it can never answer again.
            wedgedTimer = setTimeout(() => {
                if (exitSeen) return;
                logger.error("[APP-SERVER WEDGED] stdout ended but the process runs on; stopping it", JSON.stringify({generation}));
                child.failing = true;
                this.terminate(child);
            }, this.timings.wedgedAfterMs);
        });

        let terminating = false;
        child.terminate = () => {
            if (exitSeen || terminating) return;
            terminating = true;
            try {
                process.stdin?.end();
            } catch {
                // The pipe is gone already.
            }
            setTimeout(() => {
                if (exitSeen) return;
                logger.log("[APP-SERVER STOP] still running after the end of stdin; sending SIGTERM", {generation});
                try {
                    process.kill("SIGTERM");
                } catch {
                    // Already gone.
                }
                setTimeout(() => {
                    if (exitSeen) return;
                    exitSeen = true;
                    markDead();
                    logger.error("[APP-SERVER STOP] still running after SIGTERM; closing its pipes and moving on", JSON.stringify({generation}));
                    finalize(record(null, null, "it did not stop after SIGTERM"));
                }, this.timings.abandonAfterMs);
            }, this.timings.terminateAfterMs);
        };
        return child;
    }

    private terminate(child: SupervisedChild): void {
        child.terminate();
    }
}

function destroyPipes(connection: CodexConnection): void {
    const process = connection.process;
    for (const stream of [process.stdin, process.stdout, process.stderr]) {
        try {
            (stream as {destroy?: () => void} | undefined)?.destroy?.();
        } catch {
            // Already closed.
        }
    }
}
