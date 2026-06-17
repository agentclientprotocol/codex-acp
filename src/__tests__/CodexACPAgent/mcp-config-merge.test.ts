// noinspection ES6RedundantAwait

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {createBaseTestFixture, removeDirectoryWithRetry, type TestFixture} from "../acp-test-utils";

describe('MCP config merge across global config and ACP request', { timeout: 40_000 }, () => {

    let codexHome: string;
    let fixture: TestFixture;

    beforeEach(() => {
        vi.clearAllMocks();

        const configToml = `
[mcp_servers.shared-mcp]
url = "https://example.com/mcp"
`;
        codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-mcp-merge-"));
        fs.writeFileSync(path.join(codexHome, "config.toml"), configToml, "utf8");

        const codexConnection = startCodexConnection(undefined, {
            ...process.env,
            CODEX_HOME: codexHome,
        });

        fixture = createBaseTestFixture({
            connection: codexConnection.connection,
            getExitCode: () => codexConnection.process.exitCode,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        removeDirectoryWithRetry(codexHome);
    });

    it('should preserve the global url-based MCP when ACP passes a command-type MCP with the same name', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const conflictingMcp: McpServerStdio = {
            name: "shared-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        const newSessionResponse = await codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [conflictingMcp],
        });
        fixture.clearAcpConnectionDump();

        await codexAcpAgent.prompt({
            sessionId: newSessionResponse.sessionId,
            prompt: [{type: "text", text: "/mcp"}],
        });

        const transportDump = fixture.getAcpConnectionDump([]);
        expect(transportDump).contain("Configured MCP servers:");
        expect(transportDump).contain("- shared-mcp");
    });

    it('should pass the conflicting ACP MCP through when config filtering is disabled', async () => {
        vi.stubEnv("DISABLE_MCP_CONFIG_FILTERING", "true");
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const conflictingMcp: McpServerStdio = {
            name: "shared-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        await codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [conflictingMcp],
        });

        const threadStartRequest = fixture.getCodexConnectionEvents([])
            .find(event => event.eventType === "request" && event.method === "thread/start");
        expect(threadStartRequest).toMatchObject({
            params: {
                config: {
                    mcp_servers: {
                        "shared-mcp": {
                            command: "./node_modules/.bin/mcp-hello-world",
                            args: ["example"],
                            env: {example: "example"},
                        },
                    },
                },
            },
        });
    });
});
