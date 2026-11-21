import {describe, expect, it, vi} from 'vitest';
import type * as acp from '@agentclientprotocol/sdk/unstable';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {codexResponse, connectSession, createThread, cwd, sessionId} from './v2-prompt-harness';
import type {AcpMcpServer, McpOverAcpToHttp} from '../../McpServerConfig';
import {CodexAcpClient, type JsonObject} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';

/** Starts a session and returns the config sent to Codex `thread/start`. */
async function startSessionWithMcpServers(
    mcpServers: Array<AcpMcpServer> | undefined, configuredNames: string[] = [], toHttp?: McpOverAcpToHttp, overrides?: JsonObject,
) {
    const codexAppServerClient = new CodexAppServerClient(createMockConnections().mockCodexConnection);
    const codexAcpClient = new CodexAcpClient(codexAppServerClient, overrides, undefined, toHttp);
    vi.spyOn(codexAppServerClient, "hasExperimentalFeature").mockResolvedValue(true);
    await codexAcpClient.initialize({});

    vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({
        config: {mcp_servers: Object.fromEntries(configuredNames.map(name => [name, {}]))}, origins: {}, layers: [],
    } as any);
    const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
        thread: {id: "thread-id"} as any,
        model: "gpt-5",
        reasoningEffort: "medium",
        serviceTier: null,
    } as any);
    vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
        data: [createTestModel({id: "gpt-5"})],
        nextCursor: null,
    });

    await codexAcpClient.newSession({
        cwd: "/workspace",
        ...(mcpServers !== undefined && {mcpServers}),
    });
    return threadStartSpy.mock.calls[0]![0].config!;
}

describe('MCP server config from ACP v1 and v2 session requests', () => {
    it('converts v2 stdio and http servers, defaulting omitted optional fields', async () => {
        const v2Servers: Array<acpV2.McpServer> = [
            {
                type: "stdio",
                name: "stdio-full",
                command: "/usr/local/bin/mcp-fs",
                args: ["--root", "/workspace"],
                env: [{name: "EXAMPLE", value: "1"}],
            },
            {type: "stdio", name: "stdio-minimal", command: "/usr/local/bin/mcp-minimal"},
            {
                type: "http",
                name: "http-full",
                url: "https://example.com/mcp",
                headers: [{name: "Authorization", value: "Bearer token"}],
            },
            {type: "http", name: "http-minimal", url: "https://example.com/minimal"},
        ];

        const config = await startSessionWithMcpServers(v2Servers);
        expect(config["features"]).not.toHaveProperty("mcp_2026_07_28");
        await expect(JSON.stringify(config["mcp_servers"], null, 2))
            .toMatchFileSnapshot("data/mcp-config-v2-servers.json");
    });

    it('converts an untagged v1 stdio server and a v1 http server', async () => {
        const v1Servers: Array<acp.McpServer> = [
            {name: "stdio-v1", command: "npx", args: ["server"], env: [{name: "EXAMPLE", value: "1"}]},
            {
                type: "http",
                name: "http-v1",
                url: "https://example.com/mcp",
                headers: [{name: "Authorization", value: "Bearer token"}],
            },
        ];

        await expect(JSON.stringify((await startSessionWithMcpServers(v1Servers))["mcp_servers"], null, 2))
            .toMatchFileSnapshot("data/mcp-config-v1-servers.json");
    });

    it('adds no MCP config when mcpServers is omitted', async () => {
        expect(await startSessionWithMcpServers(undefined)).not.toHaveProperty("mcp_servers");
    });

    it('re-exports ACP registrations after name filtering and preserves their opaque server IDs', async () => {
        const toHttp = vi.fn<McpOverAcpToHttp>().mockResolvedValue({
            type: "http", name: "my_tools", url: "http://127.0.0.1:1234/tools", headers: [{name: "Authorization", value: "Bearer test-only"}],
        });
        const tools = {type: "acp", name: "my tools", serverId: "client/opaque id"} as const;
        const skipped = {...tools, name: "existing"};
        const local = {...tools, name: "local"};
        const overrides = {
            mcp_servers: {other: {command: "other"}},
            "mcp_servers.local.url": "https://example.com/local",
            "features.mcp_2026_07_28": false, features: {other: true},
        };
        const config = await startSessionWithMcpServers([tools, skipped, local], ["existing"], toHttp, overrides);
        expect(toHttp.mock.calls).toEqual([[tools]]);
        expect(config["mcp_servers"]).toEqual({
            other: {command: "other"}, local: {url: "https://example.com/local"},
            my_tools: {url: "http://127.0.0.1:1234/tools", http_headers: {Authorization: "Bearer test-only"}},
        });
        expect(Object.keys(config)).not.toContain("mcp_servers.local.url");
        expect(Object.keys(config)).not.toContain("features.mcp_2026_07_28");
        expect(config["features"]).toMatchObject({other: true, mcp_2026_07_28: true});

        const filtered = await startSessionWithMcpServers([skipped, local], ["existing"], toHttp, overrides);
        expect(filtered["features"]).toMatchObject({other: true, mcp_2026_07_28: false});
        expect(toHttp).toHaveBeenCalledTimes(1);
    });

    it('keeps healthy servers when an ACP bridge fails to open', async () => {
        const toHttp = vi.fn<McpOverAcpToHttp>().mockRejectedValue(new Error("listen failed"));
        const config = await startSessionWithMcpServers([
            {type: "acp", name: "tools", serverId: "id"}, {type: "http", name: "healthy", url: "https://example.com"},
        ], [], toHttp);
        expect(config["mcp_servers"]).toEqual({healthy: {url: "https://example.com", http_headers: {}}});
        expect(config["features"]).not.toHaveProperty("mcp_2026_07_28");
    });

    it.each([1, 2] as const)('reports a bridge startup failure on the fork without rejecting setup on v%i', async version => {
        const client = await connectSession(version, {
            mcpBridge: async () => { throw new Error("listen failed"); },
            codexResponses: {"thread/fork": async () => ({
                ...codexResponse("thread/start") as object, thread: {...createThread(), id: "fork"},
            })},
        });
        try {
            await expect(client.request("session/fork", {sessionId, cwd,
                mcpServers: [{type: "acp", name: "broken", serverId: "opaque"}],
            })).resolves.toMatchObject({sessionId: "fork"});
            await vi.waitFor(() => expect(client.scopedUpdates).toContainEqual(expect.objectContaining({
                sessionId: "fork", update: expect.objectContaining({
                    title: "mcp__broken__startup", status: "failed",
                    content: [{type: "content", content: {type: "text", text: expect.stringContaining("Could not open the MCP-over-ACP endpoint")}}],
                }),
            })));
        } finally { client.connection.close(); }
    });

    it('rejects sse, custom transports, and an ACP declaration without a serverId', async () => {
        const unsupported: Record<string, unknown> = {
            "v2 sse": {type: "sse", name: "sse", url: "https://example.com/sse"},
            "v2 custom": {type: "_custom", name: "custom", endpoint: "somewhere"},
            "v1 sse": {type: "sse", name: "sse", url: "https://example.com/sse", headers: []} satisfies acp.McpServer,
            "obsolete acp id": {type: "acp", name: "acp", id: "server-1"},
        };
        const rejections: Record<string, unknown> = {};
        for (const [label, server] of Object.entries(unsupported)) {
            const error = await startSessionWithMcpServers([server as AcpMcpServer]).then(() => null, err => err);
            rejections[label] = error && {code: error.code, message: error.message, data: error.data};
        }

        await expect(JSON.stringify(rejections, null, 2))
            .toMatchFileSnapshot("data/mcp-config-unsupported-transports.json");
    });

    it.each([
        {type: "stdio", name: "existing", command: "./bin/mcp"},
        {type: "stdio", name: "existing", command: "mcp"},
        {type: "sse", name: "existing", url: "https://example.com/sse", headers: []},
        {type: "acp", name: "existing", serverId: "not-available"},
    ] satisfies AcpMcpServer[])('validates $type declarations even when the name is already configured', async server => {
        await expect(startSessionWithMcpServers([server], ["existing"])).rejects.toMatchObject({code: -32602});
    });

    it.each([
        ["v1", undefined, "files"],
        ["v2", "stdio", "files"],
        ["sanitized collision", "stdio", "file server"],
    ])('rejects duplicate names before configured-server filtering: %s', async (_label, type, name) => {
        const server = {name, command: "/bin/mcp-fs", args: [], env: [], ...(type ? {type} : {})} as AcpMcpServer;
        const duplicate = {...server, name: name.replace(/ /g, "_")} as AcpMcpServer;
        await expect(startSessionWithMcpServers([server, duplicate], [duplicate.name as string]))
            .rejects.toMatchObject({code: -32602, data: {name: duplicate.name}});
    });

    it('uses the last stdio environment entry with a repeated name', async () => {
        const config = await startSessionWithMcpServers([{type: "stdio", name: "files", command: "C:\\Tools\\mcp-fs.exe",
            env: [{name: "EXAMPLE", value: "first"}, {name: "EXAMPLE", value: "last"}]}]);
        expect(config["mcp_servers"]).toMatchObject({files: {env: {EXAMPLE: "last"}}});
    });
});
