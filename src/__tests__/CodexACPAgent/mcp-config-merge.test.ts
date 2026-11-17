// noinspection ES6RedundantAwait

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type {McpServerStdio} from "@agentclientprotocol/sdk/unstable";
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

[mcp_servers.disabled-mcp]
command = "./node_modules/.bin/mcp-hello-world"
enabled = false
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

        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

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
        expect(transportDump).contain("**MCP servers:** ");
        expect(transportDump).contain("- `shared-mcp`");
    });

    it('should preserve a project url-based MCP when ACP passes a command-type MCP with the same name', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

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

    const clientMcp: McpServerStdio = {
        name: "client-mcp",
        command: path.resolve("node_modules/.bin/mcp-hello-world"),
        args: [],
        env: [],
    };

    /** MCP servers the session will run: every server its thread reports, less the disabled ones. */
    async function sessionMcpServerNames(meta?: Record<string, unknown>): Promise<string[]> {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const newSessionResponse = await codexAcpAgent.newSession({
            cwd: projectPath,
            mcpServers: [clientMcp],
            ...(meta && {_meta: meta}),
        });
        const status = await fixture.getCodexAcpClient().appServerClient.listMcpServerStatus({
            threadId: newSessionResponse.sessionId,
        });
        return status.data
            .filter(server => server.runtimeStatus !== "disabled")
            .map(server => server.name)
            .sort();
    }

    it('should give a strictMcpConfig session only the ACP MCP servers', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

        expect(await sessionMcpServerNames()).toEqual(["client-mcp", "shared-mcp"]);
        expect(await sessionMcpServerNames({codex: {strictMcpConfig: true}})).toEqual(["client-mcp"]);
    });

    it('should disable a trusted project MCP server in a strictMcpConfig session', async () => {
        fs.appendFileSync(
            path.join(codexHome, "config.toml"),
            `\n[projects.${JSON.stringify(fs.realpathSync(projectPath))}]\ntrust_level = "trusted"\n`,
            "utf8",
        );
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

        expect(await sessionMcpServerNames()).toEqual(["client-mcp", "project-mcp", "shared-mcp"]);
        expect(await sessionMcpServerNames({codex: {strictMcpConfig: true}})).toEqual(["client-mcp"]);
    });

    it('should reject a strictMcpConfig session whose ACP MCP server shares a configured name', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

        const conflictingMcp: McpServerStdio = {
            name: "shared-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: [],
            env: [],
        };

        await expect(codexAcpAgent.newSession({
            cwd: projectPath,
            mcpServers: [conflictingMcp],
            _meta: {codex: {strictMcpConfig: true}},
        })).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("shared-mcp"),
        });
    });

    it('should not wait for an ACP MCP that a disabled MCP of the same name in the config replaces', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

        const replacedMcp: McpServerStdio = {
            name: "disabled-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [],
        };
        const brokenMcp: McpServerStdio = {
            name: "broken-mcp",
            command: "./node_modules/.bin/missing-mcp-server",
            args: [],
            env: [],
        };

        await codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [replacedMcp, brokenMcp],
            _meta: {mcpStartupAwaitTimeoutMs: 60_000},
        });

        await vi.waitFor(() => {
            const dump = fixture.getAcpConnectionDump([]);
            expect(dump).toContain("MCP server `broken-mcp` failed to start");
            expect(dump).toContain("MCP server `disabled-mcp` was not started, because the Codex config already defines an MCP server with this name.");
        });
    });

    it('should not filter the conflicting ACP MCP when config filtering is disabled', async () => {
        vi.stubEnv("DISABLE_MCP_CONFIG_FILTERING", "true");
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});

        const conflictingMcp: McpServerStdio = {
            name: "shared-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        await expect(codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [conflictingMcp],
        })).rejects.toMatchObject({
            message: expect.stringMatching(/url is not supported for stdio[\s\S]*config\.toml/),
        });
    });
});
