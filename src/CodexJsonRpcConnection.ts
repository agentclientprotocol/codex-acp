import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import crossSpawn from "cross-spawn";
import type {Socket} from "node:net";
import {ownedProcessHelperArgs} from "./CodexProcessHelpers";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

const require = createRequire(import.meta.url);

const terminationTimeoutMs = 5_000;
interface OwnedProcess {
    groupId?: number;
    control?: Socket;
    termination?: Promise<void>;
}
const ownedProcesses = new WeakMap<ChildProcessWithoutNullStreams, OwnedProcess>();

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
}

export function startCodexConnection(
    codexPath?: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
): CodexConnection {
    const spawnEnv = env ?? process.env;

    let codex: ChildProcessWithoutNullStreams;
    if (process.platform !== "win32") {
        const command = codexPath ?? process.execPath;
        const args = codexPath ? appServerStartupArgs
            : [require.resolve("@openai/codex/bin/codex.js"), ...appServerStartupArgs];
        codex = spawn(process.execPath, ownedProcessHelperArgs("supervisor", [command, ...args]), {
            env: spawnEnv,
            windowsHide: true,
            detached: true,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
        const control = codex.stdio[3] as Socket;
        // A broken control pipe is checked by termination via group disappearance.
        control.on("error", () => {});
        control.unref(); // This extra lifeline must not keep the adapter event loop alive.
        ownedProcesses.set(codex, {...(codex.pid === undefined ? {} : {groupId: codex.pid}), control});
    } else if (codexPath) {
        // cross-spawn runs `.cmd` shims through cmd.exe with correct escaping for the TOML hook override.
        codex = crossSpawn(codexPath, appServerStartupArgs, {env: spawnEnv, windowsHide: true}) as ChildProcessWithoutNullStreams;
    } else {
        const bundledCodexPath = require.resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...appServerStartupArgs], {env: spawnEnv, windowsHide: true});
    }
    if (!ownedProcesses.has(codex)) ownedProcesses.set(codex, {});

    attachLogs(codex);

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // Terminate all current activities on process termination
    codex.on("exit", _ => {
        connection.dispose();
    });

    return {connection: connection, process: codex};
}

function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}

/** Stops an unresponsive owned provider before allowing the client to reconnect. */
export function terminateCodexConnection(native: CodexConnection): Promise<void> {
    const child = native.process;
    let owned = ownedProcesses.get(child);
    if (!owned) {
        // Do not infer group ownership from a caller-supplied PID.
        owned = {};
        ownedProcesses.set(child, owned);
        owned.termination = Promise.reject(new Error("Cannot terminate an unowned provider tree"));
    }
    // Cache failures as well as successes: retrying taskkill against an old PID is unsafe.
    return owned.termination ??= (async () => {
        native.connection.dispose();
        if (child.pid === undefined) return; // spawn failed; no OS process was created
        if (owned.groupId !== undefined) {
            owned.control!.end("stop");
            await waitForTermination(() => hasExited(child) && !groupExists(owned.groupId!));
        } else {
            // A reaped Windows launcher no longer proves ownership of its PID/tree.
            if (hasExited(child)) throw new Error("Provider exited before tree termination; tree state is unknown");
            await terminateWindowsTree(child.pid);
            await waitForTermination(() => hasExited(child));
        }
    })();
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function groupExists(groupId: number): boolean {
    try {
        process.kill(-groupId, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
    }
}

async function waitForTermination(stopped: () => boolean): Promise<void> {
    const deadline = Date.now() + terminationTimeoutMs;
    while (!stopped()) {
        if (Date.now() >= deadline) throw new Error("Provider tree termination timed out; tree state is unknown");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function terminateWindowsTree(pid: number): Promise<void> {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            killer.kill();
            reject(new Error("Provider tree termination timed out; tree state is unknown"));
        }, terminationTimeoutMs);
        killer.once("error", error => {clearTimeout(timer); reject(error);});
        killer.once("exit", code => {
            clearTimeout(timer);
            // Launcher exit alone cannot turn a failed tree kill into success.
            if (code === 0) resolve();
            else reject(new Error("Provider tree termination failed; tree state is unknown"));
        });
    });
}
