import {randomUUID} from "node:crypto";
import type {SandboxPolicy} from "./app-server/v2";
import type {CommandExecOutputDeltaNotification, CommandExecResponse} from "./app-server/v2";
import {
    KANDEV_GUARDED_TTY_CAPABILITY,
    KANDEV_GUARDED_TTY_VERSION,
    type KandevGuardedTtyDenialCode,
    type KandevGuardedTtyExecReceipt,
} from "./AcpExtensions";

export const GUARDED_TTY_MAX_ARG_COUNT = 64;
export const GUARDED_TTY_MAX_ARG_BYTES = 8 * 1024;
export const GUARDED_TTY_MAX_SINGLE_ARG_BYTES = 4 * 1024;
export const GUARDED_TTY_OUTPUT_BYTES_MAX = 64 * 1024;
export const GUARDED_TTY_TIMEOUT_MS = 10_000;
const GUARDED_TTY_BRIDGE_TIMEOUT_GRACE_MS = 1_000;
const GUARDED_TTY_TERMINATION_GRACE_MS = 1_000;

export interface GuardedTtyExecTransport {
    commandExec(params: {
        command: string[];
        processId: string;
        tty: true;
        streamStdin: true;
        streamStdoutStderr: true;
        outputBytesCap: number;
        timeoutMs: number;
        cwd: string;
        sandboxPolicy: SandboxPolicy;
    }): Promise<CommandExecResponse>;
    commandExecTerminate(params: {processId: string}): Promise<Record<string, never>>;
    captureCommandExecOutput(
        processId: string,
        capture: (event: CommandExecOutputDeltaNotification) => void,
    ): () => void;
}

export interface GuardedTtyExecOptions {
    sessionId: string;
    argv: string[];
    cwd: string;
    sandboxPolicy: SandboxPolicy;
    signal?: AbortSignal;
    isSessionCurrent: () => boolean;
    now?: () => Date;
}

type TerminalEvent =
    | {kind: "response", response: CommandExecResponse}
    | {kind: "failure", code: KandevGuardedTtyDenialCode};

export function validateGuardedTtyArgv(argv: string[]): boolean {
    if (argv.length === 0 || argv.length > GUARDED_TTY_MAX_ARG_COUNT) return false;
    let totalBytes = 0;
    for (const arg of argv) {
        if (typeof arg !== "string" || arg.length === 0 || arg.includes("\0")) return false;
        const bytes = Buffer.byteLength(arg);
        if (bytes > GUARDED_TTY_MAX_SINGLE_ARG_BYTES) return false;
        totalBytes += bytes;
        if (totalBytes > GUARDED_TTY_MAX_ARG_BYTES) return false;
    }
    return true;
}

export function createUndispatchedGuardedTtyReceipt(
    sessionId: string,
    denialCode: KandevGuardedTtyDenialCode,
    now: () => Date = () => new Date(),
): KandevGuardedTtyExecReceipt {
    const timestamp = now().toISOString();
    return {
        capability: KANDEV_GUARDED_TTY_CAPABILITY,
        version: KANDEV_GUARDED_TTY_VERSION,
        session_id: sessionId,
        method: "command/exec",
        requested_tty: true,
        dispatched_tty: false,
        process_id: null,
        cwd: null,
        outcome: "denied",
        denial_code: denialCode,
        stdout: "",
        stderr: "",
        stdout_bytes: 0,
        stderr_bytes: 0,
        output_bytes: 0,
        exit_code: null,
        started_at: timestamp,
        completed_at: timestamp,
    };
}

export async function executeGuardedTtyExec(
    transport: GuardedTtyExecTransport,
    options: GuardedTtyExecOptions,
): Promise<KandevGuardedTtyExecReceipt> {
    const now = options.now ?? (() => new Date());
    if (!options.isSessionCurrent()) {
        return createUndispatchedGuardedTtyReceipt(options.sessionId, "stale_session", now);
    }

    const processId = randomUUID();
    const startedAt = now().toISOString();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resolveTerminal: (event: TerminalEvent) => void = () => {};
    const terminal = new Promise<TerminalEvent>((resolve) => {
        resolveTerminal = resolve;
    });
    let finalized = false;
    let terminationRequested = false;
    let dispatched = false;
    let termination: Promise<void> | null = null;

    const requestTermination = () => {
        if (!dispatched || terminationRequested) return;
        terminationRequested = true;
        termination = transport.commandExecTerminate({processId}).then(
            () => {},
            () => {},
        );
    };
    const finalize = (event: TerminalEvent) => {
        if (finalized) return;
        finalized = true;
        resolveTerminal(event);
    };
    const fail = (code: KandevGuardedTtyDenialCode) => {
        requestTermination();
        finalize({kind: "failure", code});
    };

    const releaseOutput = transport.captureCommandExecOutput(processId, (event) => {
        if (finalized || event.processId !== processId) return;
        if (!options.isSessionCurrent()) {
            fail("stale_session");
            return;
        }
        const bytes = decodeBase64(event.deltaBase64);
        if (bytes === null) {
            fail("invalid_output");
            return;
        }
        if (event.capReached || stdoutBytes + stderrBytes + bytes.length > GUARDED_TTY_OUTPUT_BYTES_MAX) {
            fail("output_overflow");
            return;
        }
        if (event.stream === "stdout") {
            stdout.push(bytes);
            stdoutBytes += bytes.length;
        } else {
            stderr.push(bytes);
            stderrBytes += bytes.length;
        }
    });

    const abort = () => {
        const reason = options.signal?.reason;
        fail(reason === "stale_session" ? "stale_session" : "cancelled");
    };
    if (options.signal?.aborted) {
        abort();
    } else {
        options.signal?.addEventListener("abort", abort, {once: true});
    }

    const timeout = setTimeout(() => {
        fail("timeout");
    }, GUARDED_TTY_TIMEOUT_MS + GUARDED_TTY_BRIDGE_TIMEOUT_GRACE_MS);

    if (!finalized) {
        dispatched = true;
        void transport.commandExec({
            command: [...options.argv],
            processId,
            tty: true,
            streamStdin: true,
            streamStdoutStderr: true,
            outputBytesCap: GUARDED_TTY_OUTPUT_BYTES_MAX,
            timeoutMs: GUARDED_TTY_TIMEOUT_MS,
            cwd: options.cwd,
            sandboxPolicy: options.sandboxPolicy,
        }).then(
            (response) => {
                if (!options.isSessionCurrent()) {
                    fail("stale_session");
                    return;
                }
                finalize({kind: "response", response});
            },
            () => finalize({kind: "failure", code: "app_server_error"}),
        );
    }

    const event = await terminal;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    releaseOutput();
    if (termination !== null) {
        await waitWithTimeout(termination, GUARDED_TTY_TERMINATION_GRACE_MS);
    }

    const stdoutContent = Buffer.concat(stdout, stdoutBytes).toString("utf8");
    const stderrContent = Buffer.concat(stderr, stderrBytes).toString("utf8");
    const completedAt = now().toISOString();
    if (event.kind === "response") {
        return {
            capability: KANDEV_GUARDED_TTY_CAPABILITY,
            version: KANDEV_GUARDED_TTY_VERSION,
            session_id: options.sessionId,
            method: "command/exec",
            requested_tty: true,
            dispatched_tty: true,
            process_id: processId,
            cwd: options.cwd,
            outcome: "completed",
            denial_code: null,
            stdout: stdoutContent,
            stderr: stderrContent,
            stdout_bytes: stdoutBytes,
            stderr_bytes: stderrBytes,
            output_bytes: stdoutBytes + stderrBytes,
            exit_code: event.response.exitCode,
            started_at: startedAt,
            completed_at: completedAt,
        };
    }

    return {
        capability: KANDEV_GUARDED_TTY_CAPABILITY,
        version: KANDEV_GUARDED_TTY_VERSION,
        session_id: options.sessionId,
        method: "command/exec",
        requested_tty: true,
        dispatched_tty: dispatched,
        process_id: processId,
        cwd: options.cwd,
        outcome: "failed",
        denial_code: event.code,
        stdout: stdoutContent,
        stderr: stderrContent,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        output_bytes: stdoutBytes + stderrBytes,
        exit_code: null,
        started_at: startedAt,
        completed_at: completedAt,
    };
}

function decodeBase64(value: string): Buffer | null {
    if (value.length === 0) return Buffer.alloc(0);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        return null;
    }
    return Buffer.from(value, "base64");
}

async function waitWithTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
        operation,
        new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
        }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
}
