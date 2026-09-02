import {randomUUID} from "node:crypto";
import type {Server as HttpServer} from "node:http";
import type {NextFunction, Request, Response} from "express";
import {Server as McpServer} from "@modelcontextprotocol/sdk/server/index.js";
import {createMcpExpressApp} from "@modelcontextprotocol/sdk/server/express.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    isInitializeRequest,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {THREAD_TOOLS, THREAD_TOOLS_MCP_NAME} from "./catalog";
import {CodexThreadToolExecutor} from "./executor";
import {toolError, toolResult} from "./output";
import type {JsonValue} from "../app-server/serde_json/JsonValue";

type JsonObject = {[key: string]: JsonValue | undefined};
type McpSession = {transport: StreamableHTTPServerTransport, server: McpServer};
type FallbackConfigFactory = (cwd: string) => Promise<JsonObject>;
const MAX_THREAD_CONFIGS = 256;

export class CodexThreadToolsMcpServer {
    private readonly authorization = `Bearer ${randomUUID()}`;
    private executor: CodexThreadToolExecutor | null = null;
    private readonly sessions = new Map<string, McpSession>();
    private readonly threadConfigs = new Map<string, JsonObject>();
    private httpServer: HttpServer | null = null;
    private startPromise: Promise<void> | null = null;
    private port: number | null = null;

    constructor(
        client: CodexAppServerClient,
        createFallbackConfig?: FallbackConfigFactory,
    ) {
        this.reconnect(client, createFallbackConfig);
    }

    suspend(): void {
        this.executor = null;
    }

    reconnect(client: CodexAppServerClient, createFallbackConfig?: FallbackConfigFactory): void {
        const fallback = createFallbackConfig ?? (() => this.threadToolsConfig());
        this.executor = new CodexThreadToolExecutor(
            client,
            async (threadId, cwd) => this.getThreadConfig(threadId) ?? fallback(cwd),
            (threadId, config) => this.registerThreadConfig(threadId, config),
        );
    }

    registerThreadConfig(threadId: string, config: JsonObject): void {
        this.threadConfigs.delete(threadId);
        this.threadConfigs.set(threadId, structuredClone(config));
        while (this.threadConfigs.size > MAX_THREAD_CONFIGS) {
            const oldestThreadId = this.threadConfigs.keys().next().value;
            if (oldestThreadId === undefined) break;
            this.threadConfigs.delete(oldestThreadId);
        }
    }

    forgetThreadConfig(threadId: string): void {
        this.threadConfigs.delete(threadId);
    }

    private getThreadConfig(threadId: string): JsonObject | undefined {
        const config = this.threadConfigs.get(threadId);
        if (config === undefined) return undefined;
        this.threadConfigs.delete(threadId);
        this.threadConfigs.set(threadId, config);
        return config;
    }

    async config(): Promise<JsonObject> {
        await this.start();
        if (this.port === null) throw new Error("The thread tools MCP server closed while it started");
        return {
            url: `http://127.0.0.1:${this.port}/mcp`,
            http_headers: {Authorization: this.authorization},
            default_tools_approval_mode: "approve",
            tools: {
                create_thread: {approval_mode: "prompt"},
                send_message_to_thread: {approval_mode: "prompt"},
                fork_thread: {approval_mode: "prompt"},
            },
        };
    }

    async close(): Promise<void> {
        this.suspend();
        await this.startPromise?.catch(() => {});
        const server = this.httpServer;
        this.httpServer = null;
        this.port = null;
        this.startPromise = null;
        await Promise.all(Array.from(this.sessions.values(), session => session.server.close()));
        this.sessions.clear();
        this.threadConfigs.clear();
        if (server === null) return;
        await new Promise<void>((resolve, reject) => {
            server.close(error => error === undefined ? resolve() : reject(error));
        });
    }

    private async start(): Promise<void> {
        if (this.httpServer !== null) return;
        this.startPromise ??= this.listen().catch(error => {
            this.startPromise = null;
            throw error;
        });
        await this.startPromise;
    }

    private async listen(): Promise<void> {
        const app = createMcpExpressApp({host: "127.0.0.1"});
        app.use((request: Request, response: Response, next: NextFunction) => {
            if (request.headers.authorization !== this.authorization) {
                response.sendStatus(401);
                return;
            }
            next();
        });
        app.post("/mcp", async (request: Request, response: Response) => {
            try {
                const sessionId = request.headers["mcp-session-id"];
                let transport = typeof sessionId === "string" ? this.sessions.get(sessionId)?.transport : undefined;
                if (transport === undefined && !sessionId && isInitializeRequest(request.body)) {
                    const protocolServer = this.createProtocolServer();
                    transport = this.createTransport(protocolServer);
                    await protocolServer.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
                }
                if (transport === undefined) {
                    response.status(400).json({
                        jsonrpc: "2.0",
                        error: {code: -32000, message: "Unknown MCP session"},
                        id: null,
                    });
                    return;
                }
                await transport.handleRequest(request, response, request.body);
            } catch (error) {
                if (!response.headersSent) {
                    response.status(500).json({
                        jsonrpc: "2.0",
                        error: {code: -32603, message: error instanceof Error ? error.message : String(error)},
                        id: null,
                    });
                }
            }
        });
        app.get("/mcp", (_request: Request, response: Response) => response.status(405).set("Allow", "POST, DELETE").send("Method Not Allowed"));
        app.delete("/mcp", async (request: Request, response: Response) => {
            const sessionId = request.headers["mcp-session-id"];
            const transport = typeof sessionId === "string" ? this.sessions.get(sessionId)?.transport : undefined;
            if (transport === undefined) {
                response.status(400).send("Unknown MCP session");
                return;
            }
            await transport.handleRequest(request, response);
        });

        await new Promise<void>((resolve, reject) => {
            const server = app.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (address === null || typeof address === "string") {
                    reject(new Error("The thread tools MCP server did not get a TCP port"));
                    return;
                }
                this.httpServer = server;
                this.port = address.port;
                server.unref();
                resolve();
            });
            server.once("error", reject);
        });
    }

    private createTransport(server: McpServer): StreamableHTTPServerTransport {
        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: sessionId => {
                this.sessions.set(sessionId, {transport, server});
            },
        });
        transport.onclose = () => {
            if (transport.sessionId !== undefined) this.sessions.delete(transport.sessionId);
        };
        return transport;
    }

    private createProtocolServer(): McpServer {
        const server = new McpServer(
            {name: THREAD_TOOLS_MCP_NAME, version: "1.0.0"},
            {capabilities: {tools: {}}},
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: THREAD_TOOLS}));
        server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
            try {
                const executor = this.executor;
                if (executor === null) throw new Error("Codex is reconnecting. Retry the thread tool call.");
                const value = await executor.execute(
                    request.params.name,
                    request.params.arguments ?? {},
                    context._meta,
                    context.signal,
                );
                return toolResult(value);
            } catch (error) {
                return toolError(error);
            }
        });
        return server;
    }

    private async threadToolsConfig(): Promise<JsonObject> {
        return {mcp_servers: {[THREAD_TOOLS_MCP_NAME]: await this.config()}};
    }
}
