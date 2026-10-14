import {describe, expect, it, vi} from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {createCodexMockTestFixture, createTestModel} from '../acp-test-utils';
import type {AcpMcpServer} from '../../McpServerConfig';

/**
 * Starts a session with the given MCP servers and returns the `mcp_servers` config
 * sent to Codex `thread/start`.
 */
async function startSessionWithMcpServers(mcpServers: Array<AcpMcpServer> | undefined) {
    const mockFixture = createCodexMockTestFixture();
    const codexAcpClient = mockFixture.getCodexAcpClient();
    const codexAppServerClient = mockFixture.getCodexAppServerClient();

    vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue({config: {}, origins: {}, layers: []} as any);
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
    const config = threadStartSpy.mock.calls[0]![0].config;
    return config?.["mcp_servers"] ?? null;
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

        await expect(JSON.stringify(await startSessionWithMcpServers(v2Servers), null, 2))
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

        await expect(JSON.stringify(await startSessionWithMcpServers(v1Servers), null, 2))
            .toMatchFileSnapshot("data/mcp-config-v1-servers.json");
    });

    it('adds no MCP config when mcpServers is omitted', async () => {
        expect(await startSessionWithMcpServers(undefined)).toBeNull();
    });

    it('rejects sse, acp, and custom transports', async () => {
        const unsupported: Record<string, unknown> = {
            "v2 sse": {type: "sse", name: "sse", url: "https://example.com/sse"},
            "v2 custom": {type: "_custom", name: "custom", endpoint: "somewhere"},
            "v1 sse": {type: "sse", name: "sse", url: "https://example.com/sse", headers: []} satisfies acp.McpServer,
            "v1 acp": {type: "acp", name: "acp", id: "server-1"},
        };
        const rejections: Record<string, unknown> = {};
        for (const [label, server] of Object.entries(unsupported)) {
            const error = await startSessionWithMcpServers([server as AcpMcpServer]).then(() => null, err => err);
            rejections[label] = error && {code: error.code, message: error.message, data: error.data};
        }

        await expect(JSON.stringify(rejections, null, 2))
            .toMatchFileSnapshot("data/mcp-config-unsupported-transports.json");
    });
});
