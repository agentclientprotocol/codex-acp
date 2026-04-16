// noinspection ES6RedundantAwait

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createTestFixture, type TestFixture} from "../acp-test-utils";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe('MCP session configuration', { timeout: 40_000 }, () => {

    let fixture: TestFixture;
    let testHomeDir: string;
    let previousHome: string | undefined;
    let previousCodexHome: string | undefined;

    beforeEach(() => {
        previousHome = process.env["HOME"];
        previousCodexHome = process.env["CODEX_HOME"];
        testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-mcp-home-"));
        process.env["HOME"] = testHomeDir;
        process.env["CODEX_HOME"] = path.join(testHomeDir, ".codex");
        fs.mkdirSync(process.env["CODEX_HOME"], {recursive: true});
        fixture = createTestFixture();
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (previousHome === undefined) {
            delete process.env["HOME"];
        } else {
            process.env["HOME"] = previousHome;
        }
        if (previousCodexHome === undefined) {
            delete process.env["CODEX_HOME"];
        } else {
            process.env["CODEX_HOME"] = previousCodexHome;
        }
        try {
            fs.rmSync(testHomeDir, {recursive: true, force: true});
        } catch {
            // Best-effort cleanup; Codex background writes can keep files transiently busy.
        }
    });


    it('should return configured mcp', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);
        const mcpServer: McpServerStdio = {
            name: "test-mcp", command: "./node_modules/.bin/mcp-hello-world", args: ["example"], env: [{name:"example", value: "example"}]
        };

        const newSessionResponse = await codexAcpAgent.newSession({
            cwd: path.resolve(process.cwd()),
            mcpServers: [mcpServer]
        });
        fixture.clearAcpConnectionDump();
        await codexAcpAgent.prompt({sessionId: newSessionResponse.sessionId, prompt: [{type: "text", text: "/mcp"}]});
        const transportDump = fixture.getAcpConnectionDump([]);
        expect(transportDump).contain("Configured MCP servers:");
        expect(transportDump).contain("- test-mcp");
    });

});
