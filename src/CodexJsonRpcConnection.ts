import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import crossSpawn from "cross-spawn";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

const require = createRequire(import.meta.url);

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
    if (codexPath) {
        // cross-spawn runs `.cmd` shims through cmd.exe with correct escaping for the TOML hook override.
        codex = process.platform === "win32"
            ? crossSpawn(codexPath, appServerStartupArgs, {env: spawnEnv}) as ChildProcessWithoutNullStreams
            : spawn(codexPath, appServerStartupArgs, {env: spawnEnv});
    } else {
        const bundledCodexPath = require.resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...appServerStartupArgs], {env: spawnEnv});
    }

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
export async function terminateCodexConnection(native: CodexConnection): Promise<void> {
    native.connection.dispose();
    const child = native.process;
    if (child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    if (process.platform === "win32" && child.pid !== undefined) {
        // The bundled launcher is Node with a native child; kill the owned tree, not only Node.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {windowsHide: true, stdio: "ignore"});
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { killer.kill(); reject(new Error("Provider tree termination timed out")); }, 5_000);
            killer.once("error", error => {clearTimeout(timer); reject(error);});
            killer.once("exit", code => {clearTimeout(timer); code === 0 || child.exitCode !== null ? resolve() : reject(new Error("Provider tree termination failed"));});
        });
    } else {
        child.kill("SIGKILL");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([exited, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("Provider did not exit")), 5_000);})]);
    } finally {if (timer) clearTimeout(timer);}
}
