import * as rpc from "vscode-jsonrpc/node";
import type {DataCallback, Disposable, Message, MessageConnection} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import net from "node:net";
import {homedir} from "node:os";
import path from "node:path";
import {PassThrough, type Readable, Writable} from "node:stream";
import WebSocket, {type RawData} from "ws";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection;
    readonly runtime: CodexRuntime;
}

export interface CodexRuntime {
    readonly stderr: Readable;
    readonly exitCode: number | null;
    close(): void;
    terminate(): boolean;
    onExit(listener: (exitCode: number | null) => void): () => void;
}

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv): CodexConnection {
    const spawnEnv = env ?? process.env;
    const appServerUrl = spawnEnv["CODEX_APP_SERVER_URL"];
    if (appServerUrl) {
        return connectCodexAppServer(appServerUrl, spawnEnv);
    }

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        codex = process.platform === 'win32'
            ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv })
            : spawn(codexPath, ['app-server'], { env: spawnEnv });
    } else {
        const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, 'app-server'], {env: spawnEnv});
    }

    attachLogs(codex);

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // Terminate all current activities on process termination
    const runtime = new ChildProcessRuntime(codex);
    runtime.onExit(() => connection.dispose());

    return {connection, runtime};
}

function connectCodexAppServer(url: string, env: NodeJS.ProcessEnv): CodexConnection {
    const socket = createWebSocket(url, env);
    const runtime = new WebSocketRuntime(socket);
    const connection = rpc.createMessageConnection(
        new WebSocketMessageReader(socket),
        new WebSocketMessageWriter(socket),
    );

    connection.listen();
    runtime.onExit(() => connection.dispose());

    return {connection, runtime};
}

class ChildProcessRuntime implements CodexRuntime {
    constructor(private readonly process: ChildProcessWithoutNullStreams) {}

    get stderr(): Readable {
        return this.process.stderr;
    }

    get exitCode(): number | null {
        return this.process.exitCode;
    }

    close(): void {
        this.process.stdin.end();
    }

    terminate(): boolean {
        return this.process.kill();
    }

    onExit(listener: (exitCode: number | null) => void): () => void {
        this.process.on("close", listener);
        return () => this.process.off("close", listener);
    }
}

class WebSocketRuntime implements CodexRuntime {
    readonly stderr = new PassThrough();
    exitCode: number | null = null;

    constructor(private readonly socket: WebSocket) {
        socket.once("error", (error) => {
            this.stderr.write(`${String(error)}\n`);
        });
        socket.once("close", (code) => {
            this.exitCode = code === 1000 ? 0 : 1;
        });
    }

    close(): void {
        this.socket.close();
    }

    terminate(): boolean {
        if (this.exitCode !== null || this.socket.readyState === WebSocket.CLOSED) {
            return false;
        }
        this.socket.terminate();
        return true;
    }

    onExit(listener: (exitCode: number | null) => void): () => void {
        const onClose = () => listener(this.exitCode);
        this.socket.on("close", onClose);
        return () => this.socket.off("close", onClose);
    }
}

function createWebSocket(url: string, env: NodeJS.ProcessEnv): WebSocket {
    const options: WebSocket.ClientOptions = {perMessageDeflate: false};
    if (!url.startsWith("unix://")) {
        return new WebSocket(url, options);
    }

    const configuredPath = url.slice("unix://".length);
    const codexHome = env["CODEX_HOME"] || path.join(env["HOME"] || homedir(), ".codex");
    const socketPath = configuredPath
        || path.join(codexHome, "app-server-control", "app-server-control.sock");
    return new WebSocket("ws://localhost/", {
        ...options,
        createConnection: () => net.createConnection(socketPath),
    });
}

class WebSocketMessageReader extends rpc.AbstractMessageReader {
    constructor(private readonly socket: WebSocket) {
        super();
    }

    listen(callback: DataCallback): Disposable {
        const onMessage = (data: RawData) => {
            try {
                callback(JSON.parse(webSocketDataToString(data)) as Message);
            } catch (error) {
                this.fireError(error);
            }
        };
        const onError = (error: Error) => this.fireError(error);
        const onClose = () => this.fireClose();
        this.socket.on("message", onMessage);
        this.socket.on("error", onError);
        this.socket.on("close", onClose);
        return rpc.Disposable.create(() => {
            this.socket.off("message", onMessage);
            this.socket.off("error", onError);
            this.socket.off("close", onClose);
        });
    }
}

class WebSocketMessageWriter extends rpc.AbstractMessageWriter {
    constructor(private readonly socket: WebSocket) {
        super();
    }

    async write(message: Message): Promise<void> {
        await waitUntilOpen(this.socket);
        if (this.socket.readyState !== WebSocket.OPEN) {
            throw new Error("Codex App Server WebSocket is not open");
        }
        await new Promise<void>((resolve, reject) => {
            this.socket.send(
                JSON.stringify(message),
                (error) => error ? reject(error) : resolve(),
            );
        });
    }

    end(): void {
        this.socket.close();
    }
}

async function waitUntilOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.CONNECTING) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            socket.off("open", onOpen);
            socket.off("error", onError);
        };
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        socket.on("open", onOpen);
        socket.on("error", onError);
    });
}

function webSocketDataToString(data: RawData): string {
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString("utf8");
    }
    return Buffer.from(data).toString("utf8");
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
