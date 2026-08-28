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

export class CodexThreadToolsMcpServer {
    private readonly authorization = `Bearer ${randomUUID()}`;
    private readonly executor: CodexThreadToolExecutor;
    private readonly transports = new Map<string, StreamableHTTPServerTransport>();
    private httpServer: HttpServer | null = null;
    private startPromise: Promise<void> | null = null;
    private port: number | null = null;

    constructor(client: CodexAppServerClient) {
        this.executor = new CodexThreadToolExecutor(client, () => this.config());
    }

    async config(): Promise<JsonObject> {
        await this.start();
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
        const server = this.httpServer;
        this.httpServer = null;
        this.port = null;
        this.startPromise = null;
        await Promise.all(Array.from(this.transports.values(), transport => transport.close()));
        this.transports.clear();
        if (server === null) return;
        await new Promise<void>((resolve, reject) => {
            server.close(error => error === undefined ? resolve() : reject(error));
        });
    }

    private async start(): Promise<void> {
        if (this.httpServer !== null) return;
        this.startPromise ??= this.listen();
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
                let transport = typeof sessionId === "string" ? this.transports.get(sessionId) : undefined;
                if (transport === undefined && !sessionId && isInitializeRequest(request.body)) {
                    transport = this.createTransport();
                    await this.createProtocolServer().connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
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
        app.get("/mcp", (_request: Request, response: Response) => response.status(405).set("Allow", "POST").send("Method Not Allowed"));
        app.delete("/mcp", (_request: Request, response: Response) => response.status(405).set("Allow", "POST").send("Method Not Allowed"));

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

    private createTransport(): StreamableHTTPServerTransport {
        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: sessionId => {
                this.transports.set(sessionId, transport);
            },
        });
        transport.onclose = () => {
            if (transport.sessionId !== undefined) this.transports.delete(transport.sessionId);
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
                const value = await this.executor.execute(
                    request.params.name,
                    request.params.arguments ?? {},
                    context._meta,
                );
                return toolResult(value);
            } catch (error) {
                return toolError(error);
            }
        });
        return server;
    }
}
