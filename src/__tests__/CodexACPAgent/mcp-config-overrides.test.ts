import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {McpServer} from "@agentclientprotocol/sdk";
import {CodexAcpClient} from "../../CodexAcpClient";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import type {ConfigReadResponse, ThreadStartResponse} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

describe("MCP overrides from CODEX_CONFIG", () => {
    let appServerClient: CodexAppServerClient;
    const browserOverrides = {
        env: {
            NODE_USE_ENV_PROXY: "1",
            HTTPS_PROXY: "http://127.0.0.1:7890",
        },
    };
    const docsServer: McpServer = {
        type: "http",
        name: "docs",
        url: "http://127.0.0.1:3000/mcp",
        headers: [],
    };
    const docsConfig = {url: docsServer.url, http_headers: {}};

    beforeEach(() => {
        vi.stubEnv("DISABLE_MCP_CONFIG_FILTERING", "false");
        appServerClient = createCodexMockTestFixture().getCodexAppServerClient();
        vi.spyOn(appServerClient, "configRead").mockResolvedValue({
            config: {
                mcp_servers: {
                    node_repl: {command: "node", args: ["browser-mcp.js"]},
                },
            },
            origins: {},
            layers: [],
        } as unknown as ConfigReadResponse);
        vi.spyOn(appServerClient, "threadStart").mockResolvedValue({
            thread: {id: "thread-id"},
            model: "gpt-5",
            reasoningEffort: "medium",
            serviceTier: null,
        } as ThreadStartResponse);
        vi.spyOn(appServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("preserves env-only overrides when the session supplies an unrelated MCP server", async () => {
        const client = new CodexAcpClient(appServerClient, {
            mcp_servers: {node_repl: browserOverrides},
        });

        await client.newSession({cwd: "", mcpServers: [docsServer]});

        expect(vi.mocked(appServerClient.threadStart).mock.calls[0]![0].config?.["mcp_servers"]).toEqual({
            node_repl: browserOverrides,
            docs: docsConfig,
        });
    });

    it("does not carry session MCP entries into later sessions", async () => {
        const config = {mcp_servers: {node_repl: structuredClone(browserOverrides)}};
        const client = new CodexAcpClient(appServerClient, config);

        await client.newSession({cwd: "", mcpServers: [docsServer]});
        await client.newSession({cwd: "", mcpServers: []});

        expect(config).toEqual({mcp_servers: {node_repl: browserOverrides}});
        expect(vi.mocked(appServerClient.threadStart).mock.calls[1]![0].config?.["mcp_servers"]).toEqual({
            node_repl: browserOverrides,
        });
    });

    it("replaces a same-name startup entry without mixing incompatible transports", async () => {
        const client = new CodexAcpClient(appServerClient, {
            mcp_servers: {docs: docsConfig},
        });

        await client.newSession({
            cwd: "",
            mcpServers: [{name: "docs", command: "node", args: ["docs-mcp.js"], env: []}],
        });

        expect(vi.mocked(appServerClient.threadStart).mock.calls[0]![0].config?.["mcp_servers"]).toEqual({
            docs: {command: "node", args: ["docs-mcp.js"], env: {}},
        });
    });

    it("preserves overrides while filtering conflicts with Codex-configured servers", async () => {
        const client = new CodexAcpClient(appServerClient, {
            mcp_servers: {node_repl: browserOverrides},
        });

        await client.newSession({
            cwd: "",
            mcpServers: [
                {name: "node_repl", command: "node", args: ["other-browser.js"], env: []},
                docsServer,
            ],
        });

        expect(vi.mocked(appServerClient.threadStart).mock.calls[0]![0].config?.["mcp_servers"]).toEqual({
            node_repl: browserOverrides,
            docs: docsConfig,
        });
    });

    it.each([
        {mcpConfig: null},
        {mcpConfig: "invalid"},
        {mcpConfig: ["invalid"]},
    ])("does not merge a non-object MCP config: $mcpConfig", async ({mcpConfig}) => {
        const client = new CodexAcpClient(appServerClient, {mcp_servers: mcpConfig});

        await client.newSession({cwd: "", mcpServers: [docsServer]});

        expect(vi.mocked(appServerClient.threadStart).mock.calls[0]![0].config?.["mcp_servers"]).toEqual({
            docs: docsConfig,
        });
    });
});
