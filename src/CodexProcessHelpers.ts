import {createRequire} from "node:module";

const prefix = "--internal-owned-process-";
type HelperRole = "supervisor" | "guardian";

// Keep this function self-contained: Node/Bun script runtimes execute this fixed
// built-in function with -e; compiled Bun dispatches to the same function below.
// No source code is accepted from arguments or the environment.
function helperMain(require: NodeRequire, role: string, args: string[], compiled: boolean): void {
    const {spawn} = require("node:child_process") as typeof import("node:child_process");
    const {fstatSync, closeSync, read} = require("node:fs") as typeof import("node:fs");
    const checks = {pipe(fd: number) {
        const stat = fstatSync(fd);
        if (!stat.isSocket() && !stat.isFIFO()) throw new Error("Missing private process-helper pipe");
    }};
    if (process.platform === "win32") throw new Error("POSIX process helper required");
    checks.pipe(3);
    if (role === "guardian") {
        checks.pipe(0);
        const group = Number(args[0]);
        if (args.length !== 1 || !Number.isSafeInteger(group) || group <= 1 || process.ppid !== group) {
            throw new Error("Invalid process-helper parent");
        }
        // Our live membership pins this group ID even after the leader exits.
        for (const fd of [0, 3]) {
            // One byte, EOF, or an error all mean stop. Raw reads also work for
            // Bun's inherited pipes, which need not be supported by net.Socket.
            read(fd, Buffer.alloc(1), 0, 1, null, () => process.kill(-group, "SIGKILL"));
        }
        process.stdout.write("ready");
        return;
    }
    if (role !== "supervisor" || !args[0]) throw new Error("Invalid process-helper invocation");
    // detached spawn must have established a group named after this live PID.
    // Refuse to install a guardian when invoked in a caller's shared group.
    process.kill(-process.pid, 0);
    let provider: import("node:child_process").ChildProcess | undefined;
    let pendingSignal: NodeJS.Signals | undefined;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            if (provider) provider.kill(signal);
            else pendingSignal = signal;
        });
    }
    const guardianArgs = compiled
        ? ["--internal-owned-process-guardian", String(process.pid)]
        : ["-e", `(${helperMain.toString()})(require, "guardian", process.argv.slice(1), false)`, String(process.pid)];
    const guardian = spawn(process.execPath, guardianArgs, {stdio: [3, "pipe", "inherit", "pipe"], windowsHide: true});
    closeSync(3);
    guardian.on("error", error => {console.error(error); process.exit(1);});
    guardian.on("exit", () => process.exit(1));
    guardian.stdout!.once("data", () => {
        provider = spawn(args[0]!, args.slice(1), {stdio: "inherit", windowsHide: true});
        provider.on("error", error => {console.error(error); process.exit(1);});
        provider.on("exit", (code, signal) => {
            if (signal) {
                process.removeAllListeners(signal);
                process.kill(process.pid, signal);
            } else process.exit(code ?? 1);
        });
        if (pendingSignal) provider.kill(pendingSignal);
    });
}

function isCompiledBun(): boolean {
    // Bun.main is inside the embedded filesystem only for compiled executables.
    const main = (globalThis as typeof globalThis & {Bun?: {main: string}}).Bun?.main;
    return main?.startsWith("/$bunfs/") === true || main?.startsWith("B:/~BUN/") === true;
}

export function ownedProcessHelperArgs(role: HelperRole, args: string[]): string[] {
    return isCompiledBun() ? [`${prefix}${role}`, ...args]
        : ["-e", `(${helperMain.toString()})(require, ${JSON.stringify(role)}, process.argv.slice(1), false)`, ...args];
}

/** Must run before importing the ACP application or reading its configuration. */
export async function runInternalProcessHelper(): Promise<void> {
    const flag = process.argv[2];
    if (!flag?.startsWith(prefix)) return;
    try {
        helperMain(createRequire(import.meta.url), flag.slice(prefix.length), process.argv.slice(3), true);
        // Never fall through into the ACP application while the helper is alive.
        await new Promise<never>(() => {});
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
