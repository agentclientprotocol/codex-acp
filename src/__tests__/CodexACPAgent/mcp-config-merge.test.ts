// noinspection ES6RedundantAwait

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {createBaseTestFixture, removeDirectoryWithRetry, type TestFixture} from "../acp-test-utils";

describe('MCP config merge across configured MCP servers and ACP request', { timeout: 40_000 }, () => {

    let codexHome: string;
    let projectPath: string;
    let fixture: TestFixture;

    beforeEach(() => {
        vi.clearAllMocks();

        const globalConfig = `
[mcp_servers.shared-mcp]
url = "https://example.com/mcp"
`;

        const projectConfig = `
[mcp_servers.project-mcp]
url = "https://example.com/mcp"
`;

        codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-mcp-merge-"));
        fs.writeFileSync(path.join(codexHome, "config.toml"), globalConfig, "utf8");
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-mcp-project-"));
        fs.mkdirSync(path.join(projectPath, ".codex"));
        fs.writeFileSync(path.join(projectPath, ".codex", "config.toml"), projectConfig, "utf8");

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
        removeDirectoryWithRetry(projectPath);
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

    it('should preserve a project url-based MCP when ACP passes a command-type MCP with the same name', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const conflictingMcp = {
            name: "project-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        await expect(codexAcpAgent.newSession({
            cwd: projectPath,
            mcpServers: [conflictingMcp],
        })).resolves.toBeDefined();
    });

    it('should not filter the conflicting ACP MCP when config filtering is disabled', async () => {
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

        await expect(codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [conflictingMcp],
        })).rejects.toThrow("url is not supported for stdio");
    });
});
