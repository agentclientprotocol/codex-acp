import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {appendFileSync, mkdirSync, mkdtempSync} from "node:fs";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {fileURLToPath} from "node:url";
import {expect, it, vi} from "vitest";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {AgentMode} from "../../AgentMode";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {functionCallResponse, startMockResponsesServer, textResponse} from "./mock-responses-server";

async function connectClient(
    version: 1 | 2, stream: acp.Stream, provider: acp.McpOverAcpProvider, capabilities: Record<string, unknown> = {},
) {
    if (version === 1) {
        const {agent} = acp.client().onRequest(acp.methods.client.mcp.message, provider.handleRequest).connect(stream);
        await agent.request(acp.methods.agent.initialize, {protocolVersion: 1, clientCapabilities: capabilities});
        return {agent, closeSession: (sessionId: string) => agent.request(acp.methods.agent.session.close, {sessionId})};
    }
    const {agent} = acpV2.client().onRequest(acpV2.methods.client.mcp.message, provider.handleRequest).connect(stream);
    await agent.request(acpV2.methods.agent.initialize, {protocolVersion: 2, info: {name: "test", version: "1"}, capabilities});
    return {agent, closeSession: (sessionId: string) => agent.request(acpV2.methods.agent.session.close, {sessionId})};
}

/** Passes the adapter's output on, and gives `observe` each JSON-RPC message in it, in the order the adapter wrote them. */
function observed(output: ReadableStream<Uint8Array>, observe: (message: any) => void): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let unfinished = "";
    return output.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const lines = (unfinished + decoder.decode(chunk, {stream: true})).split("\n");
            unfinished = lines.pop()!;
            for (const line of lines) if (line.trim()) observe(JSON.parse(line));
            controller.enqueue(chunk);
        },
    }));
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
            // A call through the app-server API is no tool call of the session. Codex names only its thread.
            expect(requests.filter(r => r.method === "tools/call")).toMatchObject([{
                serverId: declaration.serverId, sessionId: session.sessionId, params: {name: "echo", arguments: {message: "hello"}},
            }]);
            expect(requests.some(r => r.toolCallId !== undefined)).toBe(false);
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

    // The mock model makes the root agent call the client's tool, then a subagent call it.
    it.each([
        {version: 1, childSessions: "standard"},
        {version: 2, childSessions: "standard"},
        {version: 1, childSessions: "air"},
        {version: 1, childSessions: "none"},
    ] as const)("names the session and tool call of a tool call (ACP v$version, child sessions: $childSessions)", async ({version, childSessions}) => {
        const mock = await startMockResponsesServer();
        const scripts = {root: 0, worker: 0};
        mock.setResponseHandler(async request => {
            const metadata = (request as {client_metadata?: Record<string, string>}).client_metadata?.["x-codex-turn-metadata"];
            const agentName = metadata ? (JSON.parse(metadata) as {agent_name?: string}).agent_name : undefined;
            if (agentName === "/root/worker") {
                return scripts.worker++ === 0
                    ? functionCallResponse("child-echo", "echo", {message: "from child"}, "mcp__client_tools")
                    : textResponse("CHILD_DONE");
            }
            switch (scripts.root++) {
                case 0: return functionCallResponse("root-echo", "echo", {message: "from root"}, "mcp__client_tools");
                case 1: return functionCallResponse("delegate-once", "spawn_agent", {
                    message: "Call echo", task_name: "worker", fork_turns: "none",
                }, "collaboration");
                default: return textResponse("ROOT_DONE");
            }
        });
        const temporaryRoot = join(process.cwd(), "node_modules", ".cache", "codex-acp-tests");
        mkdirSync(temporaryRoot, {recursive: true});
        const root = mkdtempSync(join(temporaryRoot, "mcp-attribution-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model, model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled", model_provider: "integration",
            "model_providers.integration.name": "Local integration mock",
            "model_providers.integration.base_url": mock.baseUrl, "model_providers.integration.wire_api": "responses",
        });
        appendFileSync(join(codexHome, "config.toml"), "\nfeatures.multi_agent = true\nfeatures.multi_agent_v2 = true\n");
        // Full access, so that Codex does not ask before it calls the tool.
        const adapter = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome, INITIAL_AGENT_MODE: AgentMode.AgentFullAccess.id},
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        adapter.stderr.on("data", chunk => { stderr += chunk.toString(); });
        const provider = new acp.McpOverAcpProvider();
        // The child sessions and tool calls that the adapter had told the client about when it wrote each request.
        const announced = new Set<string>();
        const reported = new Set<string>();
        const requests: Array<Record<string, unknown>> = [];
        const output = observed(Readable.toWeb(adapter.stdout) as ReadableStream<Uint8Array>, ({id, method, params}) => {
            if (method === "session/update") {
                const {sessionId, update} = params;
                if (update.sessionUpdate === "subagent_update") announced.add(update.sessionId);
                if (update.sessionUpdate === "subagent_spawned") announced.add(update.subagentSessionId);
                if (update.toolCallId) reported.add(`${sessionId} ${update.toolCallId}`);
            } else if (method === "mcp/message" && id !== undefined) {
                const {sessionId, toolCallId} = params;
                requests.push({
                    method: params.method, sessionId, toolCallId,
                    ...(params.method === "tools/call" ? {
                        message: params.params.arguments.message,
                        toolCallReported: reported.has(`${sessionId} ${toolCallId}`),
                        childAnnounced: announced.has(sessionId),
                    } : {}),
                });
            }
        });
        try {
            const {agent} = await connectClient(version, acp.ndJsonStream(Writable.toWeb(adapter.stdin), output), provider, {
                auth: {_meta: {gateway: true}},
                ...(version === 1 && childSessions === "standard" ? {subagents: {}} : {}),
                ...(childSessions === "air" ? {_meta: {jetbrains: {air: {version: 1, capabilities: ["nativeSubagentSessions"]}}}} : {}),
            });
            const request = (method: string, params: unknown): Promise<any> =>
                (agent as {request(method: string, params: unknown, options: {cancellationSignal: AbortSignal}): Promise<unknown>})
                    .request(method, params, {cancellationSignal: AbortSignal.timeout(20_000)});
            await request(version === 1 ? "authenticate" : "auth/login", {
                methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
            });
            const {declaration} = provider.registerServer(agent, {name: "client tools", handler: serve});
            const {sessionId} = await request("session/new", {cwd, mcpServers: [declaration]});
            await request("session/prompt", {sessionId, prompt: [{type: "text", text: "Call echo, then delegate"}]});
            await vi.waitFor(() => expect(requests.filter(r => r["method"] === "tools/call"), stderr).toHaveLength(2), {timeout: 15_000});

            const calls = requests.filter(r => r["method"] === "tools/call");
            const fromRoot = {method: "tools/call", message: "from root", sessionId, toolCallId: "root-echo",
                toolCallReported: true, childAnnounced: false};
            if (childSessions !== "none") {
                expect(calls).toEqual([fromRoot, {method: "tools/call", message: "from child",
                    sessionId: expect.any(String), toolCallId: "child-echo",
                    toolCallReported: true, childAnnounced: true}]);
            } else {
                // The client has no session for the subagent and no report of its tool call.
                expect(calls).toEqual([fromRoot, {method: "tools/call", message: "from child",
                    sessionId, toolCallId: undefined, toolCallReported: false, childAnnounced: false}]);
            }
            // Discovery and listing are not part of a tool call. Codex does not say which thread sent them.
            const others = requests.filter(r => r["method"] !== "tools/call");
            expect(others.map(r => r["method"])).toEqual(expect.arrayContaining(["server/discover", "tools/list"]));
            expect(others.every(r => r["sessionId"] === undefined && r["toolCallId"] === undefined)).toBe(true);
        } finally {
            adapter.kill();
            await mock.close();
            removeDirectoryWithRetry(root);
        }
    });
});
