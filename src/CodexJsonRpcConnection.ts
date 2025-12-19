import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";

import fs from "node:fs";
import path from "node:path";
import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";

export function startCodexConnection(codexPath: string, logPath?: string): MessageConnection {
    const codex: ChildProcessWithoutNullStreams = spawn(`"${codexPath}" app-server`, {
        shell: process.platform === 'win32'
    });

    if (logPath) {
        attachLogs(codex, logPath);
    }

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // Terminate all current activities on process termination
    codex.on("exit", _ => {
        connection.dispose();
    });

    return connection;
}

function attachLogs(proc: ChildProcessWithoutNullStreams, logPath: string) {
    function log(message: string) {
        const logDir = path.join(logPath);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
        const logFile = path.join(logPath, "app-server.log");
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    }

    proc.stderr.on("data", (data) => {
        log("[STDERR] " + data.toString());
    });
    proc.stdout.on("data", (data: Buffer) => {
        log("[STDOUT] " + data.toString());
    });
}
