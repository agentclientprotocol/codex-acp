import {once} from "node:events";
import {createServer, type Server} from "node:http";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {WebSocketServer} from "ws";
import {startCodexConnection} from "../CodexJsonRpcConnection";

describe("Codex JSON-RPC connection", () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
        await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
    });

    it("connects to an existing WebSocket App Server", async () => {
        const webSocketServer = new WebSocketServer({port: 0});
        await once(webSocketServer, "listening");
        cleanups.push(() => closeWebSocketServer(webSocketServer));

        const address = webSocketServer.address();
        if (typeof address === "string" || address === null) {
            throw new Error("WebSocket server did not expose a TCP port");
        }
        answerProbeRequests(webSocketServer);

        const codex = startCodexConnection("/path/that/must/not/run", {
            CODEX_APP_SERVER_URL: `ws://127.0.0.1:${address.port}`,
        });
        cleanups.push(() => closeCodexConnection(codex));

        await expect(codex.connection.sendRequest("probe", {value: 42}))
            .resolves.toEqual({value: 42});
    });

    it("resolves unix:// through CODEX_HOME and connects to the default socket", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "codex-acp-ws-"));
        const socketDirectory = path.join(directory, "app-server-control");
        const socketPath = path.join(socketDirectory, "app-server-control.sock");
        await mkdir(socketDirectory);
        const httpServer = createServer();
        const webSocketServer = new WebSocketServer({server: httpServer});
        await new Promise<void>((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(socketPath, resolve);
        });
        cleanups.push(async () => {
            await closeWebSocketServer(webSocketServer);
            await closeHttpServer(httpServer);
            await rm(directory, {recursive: true, force: true});
        });
        answerProbeRequests(webSocketServer);

        const codex = startCodexConnection(undefined, {
            CODEX_APP_SERVER_URL: "unix://",
            CODEX_HOME: directory,
        });
        cleanups.push(() => closeCodexConnection(codex));

        await expect(codex.connection.sendRequest("probe", {transport: "unix"}))
            .resolves.toEqual({transport: "unix"});
    });
});

function answerProbeRequests(server: WebSocketServer): void {
    server.on("connection", socket => {
        socket.on("message", raw => {
            const request = JSON.parse(raw.toString()) as {
                id: string | number;
                method: string;
                params: unknown;
            };
            socket.send(JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: request.params,
            }));
        });
    });
}

async function closeCodexConnection(
    codex: ReturnType<typeof startCodexConnection>,
): Promise<void> {
    codex.connection.dispose();
    if (codex.runtime.exitCode !== null) {
        return;
    }
    const closed = new Promise<void>(resolve => {
        const dispose = codex.runtime.onExit(() => {
            dispose();
            resolve();
        });
    });
    codex.runtime.terminate();
    await closed;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
    for (const client of server.clients) {
        client.terminate();
    }
    if (server.address() === null) {
        return;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
}

async function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) {
        return;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
}
