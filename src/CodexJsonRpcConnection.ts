import * as rpc from "vscode-jsonrpc/node";
import {Emitter, Message, MessageConnection, DataCallback} from "vscode-jsonrpc/node";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";

import fs from "node:fs";
import path from "node:path";
import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";


export function startCodexConnection(): MessageConnection {
    //TODO: parametrize path to log
    //TODO: parametrize path to codex executable
    const logDir = path.join("/home/alex/.codex/jetbrains/");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

    const logFile = path.join(logDir, "app-server.log");

    function log(message: string) {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    }

    const codex: ChildProcessWithoutNullStreams = spawn("/home/alex/.codex/jetbrains/codex-latest", ["app-server"]);
    codex.stderr.on("data", (data) => {
        log("[STDERR] " + data.toString());
    });
    codex.stdout.on("data", (data: Buffer) => {
        log("[STDOUT] " + data.toString());
    });

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    return connection;
}
