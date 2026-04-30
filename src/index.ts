#!/usr/bin/env node

import {createRequire} from "node:module";
import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexAcpServer} from "./CodexAcpServer";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";
import packageJson from "../package.json";
import {logger} from "./Logger";
import {runLoginCommand} from "./login";
import {runCodexCli} from "./CodexCli";

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

if (process.argv[2] === "login") {
    const args = process.argv.slice(3);
    runLoginCommand(args)
        .then((success) => process.exit(success ? 0 : 1))
        .catch((error) => {
            console.error("Login error:", error.message);
            process.exit(1);
        });
} else if (process.argv[2] === "cli") {
    const args = process.argv.slice(3);
    const codexPath = getCodexPath();
    runCodexCli(codexPath, args)
        .then((exitCode) => process.exit(exitCode))
        .catch((error) => {
            console.error("Codex CLI error:", error.message);
            process.exit(1);
        });
} else {
    startAcpServer();
}

function startAcpServer() {
    const codexPath = getCodexPath();
    const configString = process.env["CODEX_CONFIG"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const modelProvider = process.env["MODEL_PROVIDER"];
    const config = configString ? JSON.parse(configString) : undefined;
    const parsedAuthRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedAuthRequest && isCodexAuthRequest(parsedAuthRequest) ? parsedAuthRequest : undefined;

    logger.log("Startup", {
        name: packageJson.name,
        version: packageJson.version,
        codexPath: codexPath,
        modelProvider: modelProvider ?? null,
        codexConfig: config ?? null,
        authRequest: authRequestString ?? null,
        defaultAuthRequest: defaultAuthRequest ?? null,
    });

    const codexConnection = startCodexConnection(codexPath);
    process.stdin.on("close", (chunk: Buffer) => {
        codexConnection.process.stdin.end();
        // Kill the codex process if it doesn't exit naturally
        setTimeout(() => {
            if (!codexConnection.process.killed) {
                logger.log("Codex still running 2s after stdin closed; terminating process");
                codexConnection.process.kill();
            }
        }, 2000);
    });

    const acpJsonStream = createJsonStream(process.stdin, process.stdout);

    function createAgent(connection: acp.AgentSideConnection): CodexAcpServer {
        const appServerClient = new CodexAppServerClient(codexConnection.connection);
        const codexClient = new CodexAcpClient(appServerClient, config, modelProvider);
        return new CodexAcpServer(connection, codexClient, defaultAuthRequest, () => codexConnection.process.exitCode);
    }

    new acp.AgentSideConnection(createAgent, acpJsonStream);
}

function getCodexPath(): string {
    return process.env["CODEX_PATH"] ?? createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
}
