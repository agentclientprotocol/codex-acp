import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {once} from "node:events";
import {mkdtempSync} from "node:fs";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration} from "./integration-fixture";

async function connectClient(version: 1 | 2, stream: acp.Stream, provider: acp.McpOverAcpProvider) {
    if (version === 1) {
        const {agent} = acp.client().onRequest(acp.methods.client.mcp.message, provider.handleRequest).connect(stream);
        await agent.request(acp.methods.agent.initialize, {protocolVersion: 1});
        return {agent, closeSession: (sessionId: string) => agent.request(acp.methods.agent.session.close, {sessionId})};
    }
    const {agent} = acpV2.client().onRequest(acpV2.methods.client.mcp.message, provider.handleRequest).connect(stream);
    await agent.request(acpV2.methods.agent.initialize, {protocolVersion: 2, info: {name: "test", version: "1"}});
    return {agent, closeSession: (sessionId: string) => agent.request(acpV2.methods.agent.session.close, {sessionId})};
}

const progress = {progressToken: "missing-tool", progress: 1};
const error = {code: -32000, message: "Unknown tool", data: null};
const cache = {ttlMs: 0, cacheScope: "private"};

/** An HTTP server that only speaks the initialize-based protocol. */
async function legacyHttpServer() {
    const methods: string[] = [];
    const server = createServer(async (req, res) => {
        if (req.method !== "POST") { res.writeHead(405).end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const {id, method} = JSON.parse(Buffer.concat(chunks).toString());
        methods.push(method);
        if (id == null) { res.writeHead(202).end(); return; }
        const outcome = method === "initialize" ? {result: {
            protocolVersion: "2025-06-18", serverInfo: {name: "legacy", version: "1"}, capabilities: {tools: {}},
        }} : method === "tools/list" ? {result: {tools: []}} : {error: {code: -32601, message: "Method not found"}};
        res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id, ...outcome}));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {server, methods, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`};
}

async function serve(request: acp.McpOperationContext): Promise<acp.McpOutcome> {
    switch (request.method) {
        case "server/discover":
            return {result: {
                resultType: "complete", supportedVersions: [acp.MCP_PROTOCOL_VERSION], capabilities: {tools: {}},
                _meta: {"io.modelcontextprotocol/serverInfo": {name: "test", version: "1"}}, ...cache,
            }};
        case "tools/list":
            return {result: {resultType: "complete", tools: [{name: "echo", inputSchema: {type: "object"}}], ...cache}};
        case "tools/call":
            if (request.params?.["name"] === "echo") {
                return {result: {resultType: "complete", content: [{type: "text", text: "hello from ACP"}]}};
            }
            await request.notify("notifications/progress", progress);
            return {error};
        default:
            throw new acp.McpProtocolError(-32601, `Unknown method: ${request.method}`);
    }
}

/** Inspect the HTTP stream directly: the app-server tool-call response contains only its final result. */
async function expectProgressAndError(http: acp.McpServerHttp) {
    const response = await fetch(http.url, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
            ...Object.fromEntries(http.headers.map(h => [h.name, h.value])),
            "Content-Type": "application/json", Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": acp.MCP_PROTOCOL_VERSION, "MCP-Method": "tools/call", "MCP-Name": "missing",
        },
        body: JSON.stringify({jsonrpc: "2.0", id: 7, method: "tools/call",
            params: acp.withMcpRequestMeta({name: "missing", _meta: {progressToken: progress.progressToken}})}),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const data = (await response.text()).split("\n").filter(line => line.startsWith("data:"));
    expect(data.map(line => JSON.parse(line.slice(5)))).toEqual([
        {jsonrpc: "2.0", method: "notifications/progress", params: progress},
        {jsonrpc: "2.0", id: 7, error},
    ]);
}

// Drive the bundled Codex MCP client directly; no model, API key, or external MCP server.
describeIntegration("integration: MCP-over-ACP", () => {
    it.each([1, 2] as const)("calls an ACP v%i client tool alongside legacy HTTP and stdio servers", async version => {
        const cwd = mkdtempSync(join(tmpdir(), "codex-acp-mcp-"));
        writeCodexHomeConfig(cwd, {
            model_provider: "offline",
            "model_providers.offline.name": "Offline test",
            "model_providers.offline.base_url": "http://127.0.0.1:1/v1",
            "model_providers.offline.wire_api": "responses",
        });
        const legacy = await legacyHttpServer();
        const overrides = {mcp_servers: {legacy_stdio: {
            command: process.execPath, args: [fileURLToPath(import.meta.resolve("mcp-hello-world/build/stdio.js"))],
        }}};
        const codex = startCodexConnection(undefined, {...process.env, CODEX_HOME: cwd});
        const exited = once(codex.process, "exit");
        const appServer = new CodexAppServerClient(codex.connection);
        const incoming = new TransformStream<Uint8Array, Uint8Array>();
        const outgoing = new TransformStream<Uint8Array, Uint8Array>();
        let endpoint!: acp.McpServerHttp;
        const router = createAcpAgentRouter((connection, toHttp) => {
            const client = new CodexAcpClient(appServer, overrides, undefined, async server => {
                const http = await toHttp(server);
                endpoint = http;
                return http;
            });
            return new CodexAcpServer(connection, client);
        });
        const routed = router.connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
        const stream = acp.ndJsonStream(incoming.writable, outgoing.readable);
        const provider = new acp.McpOverAcpProvider();
        const requests: acp.McpOperationContext[] = [];
        try {
            const {agent, closeSession} = await connectClient(version, stream, provider);
            const {declaration} = provider.registerServer(agent, {name: "client tools", handler: request => {
                requests.push(request);
                return serve(request);
            }});
            const session = await agent.buildSession(cwd)
                .withMcpServer(declaration)
                .withMcpServer({type: "http", name: "legacy_http", url: legacy.url, headers: []})
                .start();
            const names = ["client_tools", "legacy_http", "legacy_stdio"];
            const startup = await appServer.mcpStartup.await(names, 0, {
                threadId: session.sessionId, signal: AbortSignal.timeout(10000),
            });
            expect(startup.ready).toEqual(names);
            expect(legacy.methods).toContain("initialize");
            const result = await codex.connection.sendRequest("mcpServer/tool/call", {
                threadId: session.sessionId, server: "client_tools", tool: "echo", arguments: {message: "hello"},
            });
            expect(result).toMatchObject({content: [{type: "text", text: "hello from ACP"}]});
            expect(requests[0]?.method).toBe("server/discover");
            expect(requests.map(r => r.method)).toContain("tools/list");
            expect(requests.filter(r => r.method === "tools/call")).toMatchObject([{
                serverId: declaration.serverId, params: {name: "echo", arguments: {message: "hello"}},
            }]);
            expect(requests.every(r => r.protocolVersion === acp.MCP_PROTOCOL_VERSION)).toBe(true);
            expect(new Set(requests.map(r => r.requestId)).size).toBe(requests.length);

            await closeSession(session.sessionId);
            expect((await fetch(endpoint.url)).status).toBe(401);
            await expectProgressAndError(endpoint); // The registration belongs to the connection, not the session.
        } finally {
            await incoming.writable.close();
            await routed.closed;
            await outgoing.writable.close();
            codex.process.stdin.end();
            await exited;
            legacy.server.closeAllConnections();
            await new Promise<void>(done => legacy.server.close(() => done()));
            removeDirectoryWithRetry(cwd);
        }
        await expect(fetch(endpoint.url)).rejects.toThrow();
    });
});
