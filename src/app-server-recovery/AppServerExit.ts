import {RequestError} from "@agentclientprotocol/sdk";

/** The JSON-RPC error code of every request that failed because the Codex app-server is gone. */
export const CODEX_PROCESS_EXITED_ERROR_CODE = 1001;

/** How one Codex app-server child ended. */
export interface AppServerExit {
    generation: number;
    pid: number | undefined;
    code: number | null;
    signal: NodeJS.Signals | null;
    /** The spawn error, when the child never started (ENOENT, EACCES). */
    error?: string;
    /** The adapter stopped the child on purpose: shutdown or a provider restart. */
    intentional: boolean;
    at: number;
    uptimeMs: number;
    stderrTail: string;
}

/** `true` for an exit that the kernel's OOM killer causes: SIGKILL, or the shell form 128 + 9. */
export function likelyOutOfMemory(exit: Pick<AppServerExit, "code" | "signal">): boolean {
    return exit.signal === "SIGKILL" || exit.code === 137;
}

/** "exited with code 1", "was killed by SIGKILL, which usually means it ran out of memory", ... */
export function describeExit(exit: Pick<AppServerExit, "code" | "signal" | "error" | "pid">): string {
    if (exit.error !== undefined) {
        return exit.pid === undefined ? `could not be started (${exit.error})` : `stopped responding (${exit.error})`;
    }
    const oom = likelyOutOfMemory(exit) ? ", which usually means it ran out of memory" : "";
    if (exit.signal !== null) return `was killed by ${exit.signal}${oom}`;
    return `exited with code ${exit.code ?? "unknown"}${oom}`;
}

export interface AppServerUnavailableData {
    exitCode: number | null;
    signal: string | null;
    /** The adapter starts the app-server again on the next request. */
    restartable: boolean;
    retryAfterMs?: number;
}

/** A request that failed because the Codex app-server is gone, or that the adapter refused to start it again. */
export class AppServerUnavailableError extends RequestError {
    constructor(message: string, data: AppServerUnavailableData) {
        super(CODEX_PROCESS_EXITED_ERROR_CODE, message, data);
        this.name = "AppServerUnavailableError";
    }
}

/** The agent refuses to open a session that crashed the app-server too often. */
export class ThreadRefusedError extends AppServerUnavailableError {
    constructor(message: string, data: AppServerUnavailableData) {
        super(message, data);
        this.name = "ThreadRefusedError";
    }
}

/** A session closed or was opened again while the agent resumed it after an app-server restart. */
export class SessionReplacedError extends AppServerUnavailableError {
    constructor(sessionId: string) {
        super(
            `Session ${sessionId} was closed or opened again while the agent reopened it after an app-server restart.`,
            {exitCode: null, signal: null, restartable: true},
        );
        this.name = "SessionReplacedError";
    }
}

/**
 * A session whose thread had no messages when its app-server stopped. Codex writes a thread's rollout on the first
 * message, so the thread was never persisted and is gone with that app-server, and Codex cannot start a thread with
 * the same id again. The session reports this on its next use; the client starts a new session.
 */
export class UnpersistedSessionLostError extends AppServerUnavailableError {
    constructor(sessionId: string) {
        super(
            `Session ${sessionId} had no messages yet and was lost when the Codex app-server restarted. Start a new session.`,
            {exitCode: null, signal: null, restartable: false},
        );
        this.name = "UnpersistedSessionLostError";
    }
}

export function isAppServerUnavailableError(error: unknown): error is AppServerUnavailableError {
    return error instanceof RequestError && error.code === CODEX_PROCESS_EXITED_ERROR_CODE;
}

/** The error of a request that ran on a child that ended. */
export function appServerExitedError(exit: AppServerExit, restartHint: string): AppServerUnavailableError {
    const stderr = exit.stderrTail.trim();
    const message = `The Codex app-server ${describeExit(exit)}. ${restartHint}${stderr ? `\n${stderr}` : ""}`;
    return new AppServerUnavailableError(message, {
        exitCode: exit.code,
        signal: exit.signal,
        restartable: true,
    });
}

/**
 * The error of a request that ran on a child that ended before its `initialize` handshake succeeded, such as one that
 * rejected its startup config. It promises no restart, since a new app-server would read the same config, and it
 * keeps the wording of the adapter before the recovery: "Codex process has exited with code 1:" and the stderr tail.
 */
export function appServerStartupExitError(exit: AppServerExit): AppServerUnavailableError {
    const stderr = exit.stderrTail.trim();
    const described = exit.error === undefined && exit.signal === null ? `has ${describeExit(exit)}` : describeExit(exit);
    return new AppServerUnavailableError(`Codex process ${described}${stderr ? `:\n${stderr}` : ""}`, {
        exitCode: exit.code,
        signal: exit.signal,
        restartable: true,
    });
}

export function formatDuration(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 120) return `${seconds} s`;
    return `${Math.ceil(seconds / 60)} min`;
}
