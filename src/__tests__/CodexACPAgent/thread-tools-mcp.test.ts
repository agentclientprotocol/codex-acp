import {afterEach, describe, expect, it, vi} from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import {THREAD_TOOLS} from "../../thread-tools-mcp/catalog";
import {CodexThreadToolsMcpServer} from "../../thread-tools-mcp/server";

describe("Codex thread tools MCP server", () => {
    let server: CodexThreadToolsMcpServer | null = null;
    let client: Client | null = null;

    afterEach(async () => {
        await client?.close();
        await server?.close();
    });

    it("serves the thread tool catalog over authenticated HTTP", async () => {
        const threadList = vi.fn().mockResolvedValue({data: [], nextCursor: null});
        server = new CodexThreadToolsMcpServer({threadList} as unknown as CodexAppServerClient);
        const config = await server.config();
        const url = new URL(config["url"] as string);
        const authorization = (config["http_headers"] as {Authorization: string}).Authorization;

        await expect(fetch(url, {method: "POST"})).resolves.toMatchObject({status: 401});

        client = new Client({name: "thread-tools-test", version: "1.0.0"});
        const transport = new StreamableHTTPClientTransport(url, {
            requestInit: {headers: {Authorization: authorization}},
        });
        await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

        const result = await client.listTools();
        expect(result.tools.map(tool => tool.name)).toEqual(THREAD_TOOLS.map(tool => tool.name));

        const call = await client.callTool({name: "list_threads", arguments: {limit: 15}});
        expect(call.isError).not.toBe(true);
        expect(threadList).toHaveBeenCalledWith(expect.objectContaining({limit: 15}));
    });
});
