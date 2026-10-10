import {ConnectionError, ConnectionErrors, ErrorCodes, ResponseError} from "vscode-jsonrpc/node";
import type {CodexAcpClient} from "../CodexAcpClient";
import type {CodexConnection} from "../CodexJsonRpcConnection";
import {isMissingRolloutError} from "../CodexThreadErrors";
import {logger} from "../Logger";
import {
    type AppServerExit,
    appServerExitedError,
    appServerStartupExitError,
    AppServerUnavailableError,
    describeExit,
    formatDuration,
    isAppServerUnavailableError,
    likelyOutOfMemory,
    SessionReplacedError,
    UnpersistedSessionLostError,
    ThreadRefusedError,
} from "./AppServerExit";
import {AppServerConnectionLostError} from "./ConnectionLoss";
import type {CodexAppServerSupervisor, SupervisedChild} from "./CodexAppServerSupervisor";
import {CrashLoopGuard} from "./CrashLoopGuard";

/** Exit code of a Windows process that misses the VC++ runtime (0xC0000135). Starting it again cannot help. */
const MISSING_VC_RUNTIME_EXIT_CODE = 3221225781;

export interface RecoveryLimits {
    /** Crashes in `crashWindowMs` after which the app-server is not started again until the window slides. */
    crashLimit: number;
    crashWindowMs: number;
    /** Crashes while one thread was opening after which that thread is not opened again for `threadWindowMs`. */
    threadCrashLimit: number;
    threadWindowMs: number;
    /** Delay before a restart, by the number of crashes in the window (1st, 2nd, ...). The last value repeats. */
    backoffMs: number[];
    /** How long the `initialize` handshake of a restarted app-server may take. */
    handshakeTimeoutMs: number;
}

export const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = {
    // Room for the strikes of one session that is too large (`threadCrashLimit`) plus unrelated crashes, so the
    // per-session guard isolates that session before the global guard stops the app-server for every session.
    crashLimit: 5,
    crashWindowMs: 5 * 60_000,
    threadCrashLimit: 2,
    threadWindowMs: 30 * 60_000,
    backoffMs: [0, 1_000, 2_000, 4_000],
    handshakeTimeoutMs: 30_000,
};

/** Reads the overrides of `readme-dev.md` from the environment. */
export function recoveryLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RecoveryLimits {
    const limits = {...DEFAULT_RECOVERY_LIMITS};
    const crashLimit = Number(env["CODEX_ACP_APP_SERVER_CRASH_LIMIT"]);
    if (Number.isInteger(crashLimit) && crashLimit > 0) limits.crashLimit = crashLimit;
    const windowMs = Number(env["CODEX_ACP_APP_SERVER_CRASH_WINDOW_MS"]);
    if (Number.isFinite(windowMs) && windowMs > 0) limits.crashWindowMs = windowMs;
    return limits;
}

/** The session state that the recovery needs. `SessionState` has it. */
export interface RecoverableSession {
    readonly sessionId: string;
}

/** What `CodexAcpServer` does for the recovery. */
export interface RecoveryHost<S extends RecoverableSession> {
    readonly supervisor: CodexAppServerSupervisor;
    /** The installed client. */
    currentClient(): CodexAcpClient;
    /** A client for a new connection, of the same configuration as the installed one. */
    createClient(connection: CodexConnection): CodexAcpClient;
    /** Runs the app-server `initialize` of a restarted app-server; `null` before the ACP `initialize` succeeded. */
    handshake(client: CodexAcpClient): Promise<void> | null;
    /** Makes `client` the installed client: commands, async tasks and title generators of every session. */
    install(client: CodexAcpClient): void;
    /** The app-server crashed (not stopped by the adapter). Runs before its connection is disposed. */
    crashed(exit: AppServerExit): void;
    /**
     * Opens the thread of `session` again in `client`; answers the collaboration mode of the resumed thread.
     * `onSubscribed` runs once the app-server holds the thread for the connection.
     */
    resumeSession(session: S, client: CodexAcpClient, onSubscribed: () => void): Promise<{collaborationMode: string}>;
    /** Applies the collaboration mode that `session` holds to its thread in `client`. */
    applyCollaborationMode(session: S, client: CodexAcpClient): Promise<void>;
    collaborationMode(session: S): string;
    /** Refreshes what the session shows from the resumed thread (background terminals). */
    resumed(session: S): void;
    /** A value that changes when `session` closes or is opened again; `isCurrent` compares it. */
    sessionLifetime(session: S): number;
    isCurrent(session: S, lifetime: number): boolean;
    /** The state object of the session of this id that is installed (open), if any. */
    installedSession(sessionId: string): S | undefined;
}

type RecoveryState = "ready" | "starting" | "dead" | "shutdown";

/** How often a resume applies a collaboration mode that changed again while it applied the previous one. */
const MAX_MODE_APPLIES = 8;

/**
 * Brings the Codex app-server back after a crash.
 *
 * - The app-server is started again lazily, by the next request that needs it ({@link ensureRunning}), with the full
 *   `initialize` handshake. One start runs at a time, and crash restarts and provider restarts share one queue.
 * - A crash loop guard stops restarting after `crashLimit` crashes in `crashWindowMs`.
 * - A session whose thread was loaded in a dead app-server is resumed again on its next use
 *   ({@link ensureSessionReady}). A thread that the app-server died opening `threadCrashLimit` times is not opened
 *   again for `threadWindowMs`, so one huge session cannot crash the app-server of every other session in a loop.
 */
export class AppServerRecovery<S extends RecoverableSession> {
    private state: RecoveryState = "ready";
    private readyGeneration: number;
    private readonly clientGenerations = new WeakMap<CodexAcpClient, number>();
    /** The client of each running generation, to tell at its exit whether its `initialize` handshake succeeded. */
    private readonly generationClients = new Map<number, CodexAcpClient>();
    /** The generations that exited before their `initialize` handshake succeeded. */
    private readonly startupExits = new Set<number>();
    private readonly loadedGenerations = new WeakMap<S, number>();
    /** The resume of each session in flight: a lazy resume or the resume of a provider restart. */
    private readonly resumes = new WeakMap<S, Promise<void>>();
    private readonly resumesById = new Map<string, Promise<void>>();
    /** The explicit opens (`session/load`, `session/resume`) in flight, by session id. */
    private readonly opens = new Map<string, number>();
    private readonly crashGuard: CrashLoopGuard;
    private readonly threadGuard: CrashLoopGuard;
    private readonly generationLostListeners = new Map<number, Set<() => void>>();
    private transitions: Promise<unknown> = Promise.resolve();
    private respawning: Promise<void> | null = null;
    /** The client of the starting or ready generation, for the thread loads in flight at a crash. */
    private liveClient: CodexAcpClient;
    private nonRestartableExit: AppServerExit | null = null;
    /** The thread loads in flight when each generation died, taken before its drain. */
    private readonly loadsAtDeath = new Map<number, string[]>();
    /** Until then, thread loads run one at a time, so a crash can be attributed to one thread. */
    private serializeLoadsUntil = 0;
    private loadQueue: Promise<unknown> = Promise.resolve();
    /** The client generation that a provider restart started and has not installed yet. */
    private pendingReplacement: {
        generation: number,
        release: () => void,
        watchdog: ReturnType<typeof setTimeout>,
        timedOut: boolean,
    } | null = null;

    constructor(
        private readonly host: RecoveryHost<S>,
        private readonly limits: RecoveryLimits = DEFAULT_RECOVERY_LIMITS,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) {
        this.crashGuard = new CrashLoopGuard(limits.crashLimit, limits.crashWindowMs, now);
        this.threadGuard = new CrashLoopGuard(limits.threadCrashLimit, limits.threadWindowMs, now);
        this.readyGeneration = host.supervisor.generation;
        this.liveClient = host.currentClient();
        this.clientGenerations.set(this.liveClient, this.readyGeneration);
        this.generationClients.set(this.readyGeneration, this.liveClient);
        this.gateThreadLoads(this.liveClient);
        host.supervisor.onExit((exit, child) => this.handleExit(exit, child.generation));
        host.supervisor.onDeath(child => this.snapshotLoads(child.generation));
    }

    /** The generation whose client is installed. */
    get generation(): number {
        return this.readyGeneration;
    }

    /** True while the installed generation runs, nothing replaces it and the agent is not shutting down. */
    isReady(generation = this.readyGeneration): boolean {
        return this.state === "ready"
            && generation === this.readyGeneration
            && this.host.supervisor.isAlive(generation);
    }

    /**
     * Makes sure that an app-server runs, starting one when the installed one is dead.
     * Returns `undefined` when it runs already, so the normal path adds no promise and no microtask.
     */
    ensureRunning(): Promise<void> | undefined {
        if (this.isReady()) return undefined;
        return this.respawn();
    }

    /**
     * Makes sure that the thread of `session` is loaded in a running app-server: starts the app-server if needed,
     * and resumes the thread again when it was loaded in a dead one. Returns `undefined` when it is ready already.
     */
    ensureSessionReady(session: S): Promise<void> | undefined {
        if (this.sessionIsLive(session)) return undefined;
        const inFlight = this.resumes.get(session);
        if (inFlight !== undefined) {
            // One resume per session: join it, then check again (its app-server can have died meanwhile).
            return inFlight.then(() => this.ensureSessionReady(session));
        }
        return this.track(session, this.runResume(session));
    }

    /** True when the thread of `session` is loaded in the installed, running app-server. */
    sessionIsLive(session: S | undefined): boolean {
        return session !== undefined && this.isReady() && this.loadedGenerations.get(session) === this.readyGeneration;
    }

    /** Records that the thread of `session` was loaded in the app-server of `generation`. */
    markLoaded(session: S, generation: number): void {
        this.loadedGenerations.set(session, generation);
    }

    /** The end of a resume of `sessionId` that is in flight, ignoring its result; `undefined` without one. */
    settleResume(sessionId: string): Promise<void> | undefined {
        return this.resumesById.get(sessionId)?.catch(() => undefined);
    }

    /**
     * Runs an explicit open of `sessionId` (`session/load`, `session/resume`). A lazy resume does not start while it
     * runs, and does not unsubscribe a thread that it opened.
     */
    async trackOpen<T>(sessionId: string, open: () => Promise<T>): Promise<T> {
        this.opens.set(sessionId, (this.opens.get(sessionId) ?? 0) + 1);
        try {
            return await open();
        } finally {
            const count = (this.opens.get(sessionId) ?? 1) - 1;
            if (count > 0) this.opens.set(sessionId, count);
            else this.opens.delete(sessionId);
        }
    }

    /**
     * Runs the resume of a provider restart for `session` in `client` as the resume of the session: a lazy resume joins
     * it instead of resuming the thread a second time. It applies a collaboration mode chosen meanwhile, and marks the
     * session loaded in `generation` when it succeeds.
     */
    resumeForReplacement(
        session: S,
        generation: number,
        client: CodexAcpClient,
        resume: (onSubscribed: () => void) => Promise<{collaborationMode: string}>,
    ): Promise<void> {
        return this.track(session, this.resumeInto(session, generation, client, resume, false));
    }

    /**
     * Calls `listener` once when the app-server of `generation` is gone (crash or replacement), at once when it is
     * gone already. Returns the function that removes the listener.
     */
    onGenerationLost(generation: number, listener: () => void): () => void {
        if (!this.host.supervisor.isAlive(generation)) {
            listener();
            return () => {};
        }
        const listeners = this.generationLostListeners.get(generation) ?? new Set();
        listeners.add(listener);
        this.generationLostListeners.set(generation, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && this.generationLostListeners.get(generation) === listeners) {
                this.generationLostListeners.delete(generation);
            }
        };
    }

    /** Throws the error of `generation` when its app-server is gone. */
    throwIfLost(generation: number): void {
        if (this.host.supervisor.isAlive(generation)) return;
        throw this.errorForGeneration(generation);
    }

    /**
     * Maps `error` of an operation that used `client`: a failure because the connection to the app-server is gone
     * becomes an {@link AppServerUnavailableError} with the exit of that app-server. Any other error stays as it is,
     * also when the app-server died after it answered.
     */
    mapError(error: unknown, client?: CodexAcpClient): unknown {
        if (isAppServerUnavailableError(error) || !isConnectionDeathError(error)) return error;
        const generation = client !== undefined ? this.clientGenerations.get(client) : undefined;
        // An error recognized only by its text (the MCP waits of the adapter) counts only for an app-server that is gone.
        if (!isTypedConnectionDeathError(error) && this.host.supervisor.isAlive(generation)) return error;
        return this.errorForGeneration(generation);
    }

    /**
     * The error of a request that ran on the app-server of `generation`, which is gone. Without a generation it names
     * the last exit. A generation whose exit is not known yet gets no exit of another one.
     */
    errorForGeneration(generation?: number): AppServerUnavailableError {
        const supervisor = this.host.supervisor;
        const exit = generation !== undefined ? supervisor.exitOf(generation) : supervisor.lastExit;
        if (exit !== undefined) return this.exitError(exit);
        if (supervisor.shuttingDown) return this.shuttingDownError();
        return new AppServerUnavailableError(
            "The connection to the Codex app-server was lost. The agent starts it again on the next request.",
            {exitCode: null, signal: null, restartable: true},
        );
    }

    /**
     * Refuses to open `threadId` when the app-server died opening it too often, and runs `load` one at a time with
     * other loads after a crash that could not be attributed to one thread.
     */
    loadThread<T>(threadId: string, load: () => Promise<T>): Promise<T> {
        try {
            this.assertThreadMayLoad(threadId);
        } catch (error) {
            return Promise.reject(error);
        }
        if (this.now() >= this.serializeLoadsUntil) {
            return load();
        }
        return this.loadInTurn(threadId, load);
    }

    private async loadInTurn<T>(threadId: string, load: () => Promise<T>): Promise<T> {
        const previous = this.loadQueue;
        let release: () => void = () => {};
        this.loadQueue = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous.catch(() => undefined);
        try {
            this.assertThreadMayLoad(threadId);
            return await load();
        } finally {
            release();
        }
    }

    assertThreadMayLoad(threadId: string): void {
        if (!this.threadGuard.tripped(threadId)) return;
        const exit = this.host.supervisor.lastExit;
        const cause = exit !== undefined && likelyOutOfMemory(exit)
            ? "was killed (likely out of memory)"
            : "crashed";
        const count = this.threadGuard.count(threadId);
        throw new ThreadRefusedError(
            `The Codex app-server ${cause} ${count} times while opening session ${threadId}, so the agent does not open `
            + `this session again for ${formatDuration(this.threadGuard.retryAfterMs(threadId))}, to keep the other `
            + "sessions working. The session may be too large for the available memory.",
            {exitCode: exit?.code ?? null, signal: exit?.signal ?? null, restartable: false,
                retryAfterMs: this.threadGuard.retryAfterMs(threadId)},
        );
    }

    /**
     * Starts the replacement of the app-server for a provider update: waits for its turn in the transition queue,
     * stops the running app-server and starts a new one. The queue stays held until {@link completeReplacement}, or
     * until the update fails ({@link settleReplacement}). A replacement that does not get installed within the
     * handshake timeout is stopped, which fails the update and releases the queue.
     */
    async beginReplacement(): Promise<CodexAcpClient> {
        let release: () => void = () => {};
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        const turn = this.transitions.then(() => undefined, () => undefined);
        this.transitions = turn.then(() => held);
        await turn;
        try {
            const supervisor = this.host.supervisor;
            if (supervisor.shuttingDown) throw this.shuttingDownError();
            if (this.nonRestartableExit !== null) throw this.exitError(this.nonRestartableExit);
            if (this.crashGuard.tripped()) throw this.crashLoopError();
            const previous = supervisor.current;
            this.state = "starting";
            this.loseGeneration(previous.generation);
            await supervisor.stop(previous);
            // A previous child that died on its own counted its crash only at the end of its drain.
            if (supervisor.shuttingDown) throw this.shuttingDownError();
            if (this.nonRestartableExit !== null) throw this.exitError(this.nonRestartableExit);
            if (this.crashGuard.tripped()) throw this.crashLoopError();
            const {child, client} = this.spawnClient();
            const watchdog = setTimeout(() => {
                const pending = this.pendingReplacement;
                if (pending?.generation !== child.generation) return;
                logger.log("[APP-SERVER RESTART] The provider restart did not finish its handshake in time; stopping the new app-server", {
                    generation: child.generation,
                    ms: this.limits.handshakeTimeoutMs,
                });
                // The attempt is over: a late answer of initialize must not install this app-server as ready.
                pending.timedOut = true;
                child.failing = true;
                child.terminate();
            }, this.limits.handshakeTimeoutMs);
            this.pendingReplacement = {generation: child.generation, release, watchdog, timedOut: false};
            return client;
        } catch (error) {
            this.state = this.host.supervisor.shuttingDown ? "shutdown" : "dead";
            release();
            throw error;
        }
    }

    /**
     * The provider update installed `client`. Throws when the handshake of that app-server timed out meanwhile: it is
     * stopping, and the next request starts another one.
     */
    completeReplacement(client: CodexAcpClient): void {
        const pending = this.pendingReplacement;
        if (pending === null || this.clientGenerations.get(client) !== pending.generation) return;
        this.pendingReplacement = null;
        clearTimeout(pending.watchdog);
        this.readyGeneration = pending.generation;
        const usable = !pending.timedOut && this.host.supervisor.isAlive(pending.generation);
        this.state = usable ? "ready" : this.host.supervisor.shuttingDown ? "shutdown" : "dead";
        pending.release();
        if (pending.timedOut) {
            throw new AppServerUnavailableError(
                `The restarted Codex app-server did not answer initialize within ${formatDuration(this.limits.handshakeTimeoutMs)}. `
                + "The agent starts it again on the next request.",
                {exitCode: null, signal: null, restartable: true},
            );
        }
    }

    /** Releases the queue when the provider update failed before {@link completeReplacement}; stops its app-server. */
    settleReplacement(update: Promise<unknown>): void {
        update.catch(() => {
            const pending = this.pendingReplacement;
            if (pending === null) return;
            this.pendingReplacement = null;
            clearTimeout(pending.watchdog);
            this.readyGeneration = pending.generation;
            this.state = this.host.supervisor.shuttingDown ? "shutdown" : "dead";
            const child = this.host.supervisor.current;
            if (child.generation === pending.generation && !child.dead && !pending.timedOut) {
                // The handshake failed without a crash. It counts as one, like a failed restart handshake.
                this.crashGuard.record();
                logger.log("[APP-SERVER RESTART] The provider restart failed before the new app-server was installed; stopping it");
                void this.host.supervisor.stop(child);
            }
            pending.release();
        });
    }

    /** Spawns a child and its client. A spawn that throws counts as a crash and becomes a 1001 error. */
    private spawnClient(): {child: SupervisedChild, client: CodexAcpClient} {
        let child: SupervisedChild;
        let client: CodexAcpClient;
        try {
            child = this.host.supervisor.spawn();
            client = this.host.createClient(child.connection);
        } catch (error) {
            this.state = this.host.supervisor.shuttingDown ? "shutdown" : "dead";
            this.crashGuard.record();
            const message = error instanceof Error ? error.message : String(error);
            logger.error("[APP-SERVER RESTART] The Codex app-server could not be started", error);
            throw new AppServerUnavailableError(`The Codex app-server could not be started: ${message}`, {
                exitCode: null,
                signal: null,
                restartable: !this.crashGuard.tripped(),
            });
        }
        this.liveClient = client;
        this.clientGenerations.set(client, child.generation);
        this.generationClients.set(child.generation, client);
        this.gateThreadLoads(client);
        return {child, client};
    }

    /** Every request of `client` that reads a whole rollout goes through {@link loadThread}. */
    private gateThreadLoads(client: CodexAcpClient): void {
        client.appServerClient.threadLoadGate = (threadId, request) => this.loadThread(threadId, request);
    }

    private track(session: S, resume: Promise<void>): Promise<void> {
        this.resumes.set(session, resume);
        this.resumesById.set(session.sessionId, resume);
        const clear = () => {
            if (this.resumes.get(session) === resume) this.resumes.delete(session);
            if (this.resumesById.get(session.sessionId) === resume) this.resumesById.delete(session.sessionId);
        };
        void resume.then(clear, clear);
        return resume;
    }

    private respawn(): Promise<void> {
        if (this.host.supervisor.shuttingDown) return Promise.reject(this.shuttingDownError());
        if (this.nonRestartableExit !== null) return Promise.reject(this.exitError(this.nonRestartableExit));
        if (this.respawning !== null) return this.respawning;
        const attempt = this.enqueue(() => this.restart());
        this.respawning = attempt;
        void attempt.then(
            () => this.clearRespawning(attempt),
            () => this.clearRespawning(attempt),
        );
        return attempt;
    }

    private clearRespawning(attempt: Promise<void>): void {
        if (this.respawning === attempt) this.respawning = null;
    }

    private enqueue<T>(transition: () => Promise<T>): Promise<T> {
        const result = this.transitions.then(transition, transition);
        this.transitions = result.catch(() => undefined);
        return result;
    }

    private async restart(): Promise<void> {
        if (this.isReady()) return;
        const supervisor = this.host.supervisor;
        if (supervisor.shuttingDown) throw this.shuttingDownError();

        // A child that died finishes its drain first, so its crash counts below. A child that still runs but is not
        // installed (a failed install) is stopped.
        const previous = supervisor.current;
        if (previous.exit === null) {
            await supervisor.stop(previous);
        }
        if (this.isReady()) return;
        if (supervisor.shuttingDown) throw this.shuttingDownError();
        if (this.nonRestartableExit !== null) throw this.exitError(this.nonRestartableExit);
        if (this.crashGuard.tripped()) throw this.crashLoopError();

        const crashes = this.crashGuard.count();
        const delay = crashes === 0
            ? 0
            : this.limits.backoffMs[Math.min(crashes, this.limits.backoffMs.length) - 1]!;
        const lastCrashAt = this.crashGuard.lastCrashAt() ?? 0;
        const wait = Math.max(0, lastCrashAt + delay - this.now());
        if (wait > 0) {
            logger.log("[APP-SERVER RESTART] waiting before the restart", {ms: wait, crashes});
            await this.sleep(wait);
        }
        if (supervisor.shuttingDown) throw this.shuttingDownError();

        const startedAt = this.now();
        this.state = "starting";
        const {child, client} = this.spawnClient();
        let timedOut = false;
        try {
            const handshake = this.host.handshake(client);
            if (handshake !== null) {
                await this.withHandshakeTimeout(handshake, () => {
                    // The exit that this causes counts as the crash of the attempt.
                    timedOut = true;
                    child.failing = true;
                    child.terminate();
                });
            }
            if (child.dead) throw this.errorForGeneration(child.generation);
            if (supervisor.shuttingDown) throw this.shuttingDownError();
            this.host.install(client);
            this.readyGeneration = child.generation;
            this.state = "ready";
            logger.log("[APP-SERVER RESTARTED]", {
                generation: child.generation,
                ms: this.now() - startedAt,
                crashesInWindow: this.crashGuard.count(),
            });
        } catch (error) {
            this.readyGeneration = child.generation;
            this.state = supervisor.shuttingDown ? "shutdown" : "dead";
            if (!child.dead && !timedOut) {
                // The handshake failed without a crash. It counts as one, so a handshake that always fails cannot
                // start app-servers forever.
                this.crashGuard.record();
                void supervisor.stop(child);
            }
            throw this.mapError(error, client);
        }
    }

    private async withHandshakeTimeout(handshake: Promise<void>, onTimeout: () => void): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                onTimeout();
                reject(new AppServerUnavailableError(
                    `The restarted Codex app-server did not answer initialize within ${formatDuration(this.limits.handshakeTimeoutMs)}. `
                    + "The agent starts it again on the next request.",
                    {exitCode: null, signal: null, restartable: true},
                ));
            }, this.limits.handshakeTimeoutMs);
        });
        try {
            await Promise.race([handshake, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async runResume(session: S): Promise<void> {
        const running = this.ensureRunning();
        if (running) await running;
        if (this.sessionIsLive(session)) return;
        const generation = this.readyGeneration;
        const client = this.host.currentClient();
        logger.log("[APP-SERVER RECOVERY] resuming a session in the restarted app-server", {
            sessionId: session.sessionId,
            generation,
        });
        const started = this.now();
        await this.resumeInto(
            session,
            generation,
            client,
            onSubscribed => this.host.resumeSession(session, client, onSubscribed),
            true,
        );
        this.host.resumed(session);
        logger.log("[APP-SERVER RECOVERY] session resumed", {
            sessionId: session.sessionId,
            generation,
            ms: this.now() - started,
        });
    }

    /**
     * Loads the thread of `session` in the app-server of `generation`, applies the collaboration mode that the session
     * holds and marks the session loaded. Fails when the session closes or is opened again, or the app-server dies, at
     * any point; a thread that it subscribed for a session that is gone is unsubscribed again.
     * `refuseWhileOpen` fails while an explicit open of the session runs; a lazy resume sets it. A provider restart
     * does not: explicit opens wait for it.
     */
    private async resumeInto(
        session: S,
        generation: number,
        client: CodexAcpClient,
        resume: (onSubscribed: () => void) => Promise<{collaborationMode: string}>,
        refuseWhileOpen: boolean,
    ): Promise<void> {
        const sessionId = session.sessionId;
        const lifetime = this.host.sessionLifetime(session);
        const stillValid = () => this.host.isCurrent(session, lifetime)
            && this.isReady(generation)
            && !(refuseWhileOpen && this.opens.has(sessionId));
        const invalidated = () => this.isReady(generation)
            ? sessionReplacedError(sessionId)
            : this.errorForGeneration(generation);
        let subscribed = false;
        try {
            if (!stillValid()) throw invalidated();
            let resumed: {collaborationMode: string};
            try {
                resumed = await resume(() => {
                    subscribed = true;
                });
            } catch (error) {
                throw this.resumeError(sessionId, error, client);
            }
            if (!stillValid()) throw invalidated();
            // The collaboration mode is a setting of the thread in the app-server. A mode chosen while the session
            // was not live is only stored, so apply it, again if it changed while the previous apply ran.
            let applied = resumed.collaborationMode;
            for (let attempt = 0; applied !== this.host.collaborationMode(session); attempt++) {
                if (attempt >= MAX_MODE_APPLIES) throw new Error("The collaboration mode kept changing while the session was reopened");
                const wanted = this.host.collaborationMode(session);
                await this.host.applyCollaborationMode(session, client);
                applied = wanted;
                if (!stillValid()) throw invalidated();
            }
        } catch (error) {
            if (subscribed) this.releaseThread(session, generation, client);
            throw this.mapError(error, client);
        }
        this.loadedGenerations.set(session, generation);
    }

    /**
     * Unsubscribes a thread that a resume loaded for a session that closed meanwhile. A thread that another open
     * of the session uses stays subscribed: the subscription belongs to the connection, not to one open.
     */
    private releaseThread(session: S, generation: number, client: CodexAcpClient): void {
        const sessionId = session.sessionId;
        const installed = this.host.installedSession(sessionId);
        if (!this.isReady(generation) || this.opens.has(sessionId) || (installed !== undefined && installed !== session)) return;
        void client.closeSession(sessionId).catch(error => {
            logger.log("Failed to unsubscribe the thread of a session that closed while it was resumed", {
                sessionId,
                error: String(error),
            });
        });
    }

    private resumeError(sessionId: string, error: unknown, client: CodexAcpClient): unknown {
        if (isAppServerUnavailableError(error)) return error;
        const mapped = this.mapError(error, client);
        if (mapped !== error) return mapped;
        if (isMissingRolloutError(error)) {
            return new UnpersistedSessionLostError(sessionId);
        }
        const message = error instanceof Error ? error.message : String(error);
        return new AppServerUnavailableError(
            `Could not reopen session ${sessionId} after the Codex app-server restarted: ${message}`,
            {exitCode: null, signal: null, restartable: true},
        );
    }

    private handleExit(exit: AppServerExit, generation: number): void {
        const loadsAtDeath = this.loadsAtDeath.get(generation) ?? [];
        this.loadsAtDeath.delete(generation);
        const isInstalled = generation === this.readyGeneration;
        const client = this.generationClients.get(generation);
        this.generationClients.delete(generation);
        if (!exit.intentional && client?.initialized !== true) this.startupExits.add(generation);
        if (isInstalled && this.state === "ready") {
            this.state = this.host.supervisor.shuttingDown ? "shutdown" : "dead";
        }
        if (!exit.intentional) {
            this.crashGuard.record();
            if (exit.code === MISSING_VC_RUNTIME_EXIT_CODE) this.nonRestartableExit = exit;
            this.attribute(exit, loadsAtDeath);
            try {
                this.host.crashed(exit);
            } catch (error) {
                logger.error("Failed to handle the app-server crash", error);
            }
        }
        this.loseGeneration(generation);
    }

    private snapshotLoads(generation: number): void {
        if (this.clientGenerations.get(this.liveClient) !== generation) return;
        this.loadsAtDeath.set(generation, this.liveClient.appServerClient.threadLoadsInFlight());
    }

    /** Gives the crash to the thread that the app-server was opening when it died, when it was opening exactly one. */
    private attribute(exit: AppServerExit, loads: string[]): void {
        if (loads.length === 1) {
            this.threadGuard.record(loads[0]!);
            logger.error(`[APP-SERVER CRASH] The app-server ${describeExit(exit)} while opening session ${loads[0]}`, JSON.stringify({
                strikes: this.threadGuard.count(loads[0]!),
                limit: this.limits.threadCrashLimit,
            }));
        } else if (loads.length > 1) {
            this.serializeLoadsUntil = this.now() + this.limits.crashWindowMs;
            logger.error("[APP-SERVER CRASH] The app-server died while opening several sessions; opening them one at a time from now on",
                JSON.stringify({sessions: loads}));
        }
    }

    private loseGeneration(generation: number): void {
        const listeners = this.generationLostListeners.get(generation);
        if (listeners === undefined) return;
        this.generationLostListeners.delete(generation);
        for (const listener of listeners) {
            try {
                listener();
            } catch (error) {
                logger.error("App-server loss listener failed", error);
            }
        }
    }

    private exitError(exit: AppServerExit): AppServerUnavailableError {
        if (exit.code === MISSING_VC_RUNTIME_EXIT_CODE) {
            return new AppServerUnavailableError("VC++ redistributable should be installed", {
                exitCode: exit.code,
                signal: exit.signal,
                restartable: false,
            });
        }
        if (this.host.supervisor.shuttingDown) {
            return appServerExitedError(exit, "The agent is shutting down.");
        }
        if (exit.intentional) {
            return new AppServerUnavailableError(
                "The Codex app-server was restarted for a provider change while this request ran. Try again.",
                {exitCode: exit.code, signal: exit.signal, restartable: true},
            );
        }
        if (this.crashGuard.tripped()) {
            return this.crashLoopError(exit);
        }
        if (this.startupExits.has(exit.generation)) {
            return appServerStartupExitError(exit);
        }
        return appServerExitedError(exit, "The agent starts it again on the next request.");
    }

    private crashLoopError(exit = this.host.supervisor.lastExit): AppServerUnavailableError {
        const retryAfterMs = this.crashGuard.retryAfterMs();
        const last = exit !== undefined ? ` (last: it ${describeExit(exit)})` : "";
        const stderr = exit?.stderrTail.trim() ?? "";
        return new AppServerUnavailableError(
            `The Codex app-server crashed ${this.crashGuard.count()} times in the last `
            + `${formatDuration(this.limits.crashWindowMs)}${last}, so the agent stopped restarting it. `
            + `Restart the agent, or try again in ${formatDuration(retryAfterMs)}.${stderr ? `\n${stderr}` : ""}`,
            {exitCode: exit?.code ?? null, signal: exit?.signal ?? null, restartable: false, retryAfterMs},
        );
    }

    private shuttingDownError(): AppServerUnavailableError {
        return new AppServerUnavailableError("The Codex app-server is not available: the agent is shutting down.", {
            exitCode: null,
            signal: null,
            restartable: false,
        });
    }
}

function sessionReplacedError(sessionId: string): AppServerUnavailableError {
    return new SessionReplacedError(sessionId);
}

/** Messages of failures because the connection to the app-server is gone, from vscode-jsonrpc and the adapter. */
const CONNECTION_DEATH_MESSAGES = [
    "Connection is disposed",
    "Connection is closed",
    "Pending response rejected since connection got disposed",
    "Codex connection closed",
];

/** An error of vscode-jsonrpc or of the adapter's own waits that means: the connection to the app-server is gone. */
function isTypedConnectionDeathError(error: unknown): boolean {
    if (error instanceof AppServerConnectionLostError) return true;
    if (error instanceof ConnectionError) {
        return error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed;
    }
    return error instanceof ResponseError && error.code === ErrorCodes.PendingResponseRejected;
}

/**
 * An error that means: the connection to the app-server is gone. An error answer of the app-server (`ResponseError`)
 * never counts by its text: a live app-server can pass on such a text from an MCP server.
 */
export function isConnectionDeathError(error: unknown): boolean {
    if (isTypedConnectionDeathError(error)) return true;
    if (error instanceof ResponseError || !(error instanceof Error)) return false;
    return CONNECTION_DEATH_MESSAGES.some(text => error.message.includes(text));
}
