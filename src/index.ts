#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexAcpServer} from "./CodexAcpServer";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";
import packageJson from "../package.json";
import {logger} from "./Logger";

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

const codexPath = process.env["CODEX_PATH"] ?? "codex";
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
});

const acpJsonStream = createJsonStream(process.stdin, process.stdout);

function createAgent(connection: acp.AgentSideConnection): CodexAcpServer {
    const appServerClient = new CodexAppServerClient(codexConnection.connection);
    const codexClient = new CodexAcpClient(appServerClient, config, modelProvider);
    return new CodexAcpServer(connection, codexClient, defaultAuthRequest, () => codexConnection.process.exitCode);
}

new acp.AgentSideConnection(createAgent, acpJsonStream);