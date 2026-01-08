#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexAcpServer} from "./CodexAcpServer";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";
import packageJson from "../package.json";

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

const codexPath = process.env["CODEX_PATH"] ?? "codex";
const logPath = process.env["APP_SERVER_LOGS"];

const codexConnection = startCodexConnection(codexPath, logPath);
process.stdin.on("close", (chunk: Buffer) => {
    codexConnection.process.stdin.end();
});

const acpJsonStream = createJsonStream(process.stdin, process.stdout);

function createAgent(connection: acp.AgentSideConnection): CodexAcpServer {
    const configString = process.env["CODEX_CONFIG"];
    const config = configString ? JSON.parse(configString) : undefined;
    const modelProvider= process.env["MODEL_PROVIDER"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const parsedRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedRequest && isCodexAuthRequest(parsedRequest) ? parsedRequest : undefined;
    const appServerClient = new CodexAppServerClient(codexConnection.connection);
    const codexClient = new CodexAcpClient(appServerClient, config, modelProvider)
    return new CodexAcpServer(connection, codexClient, defaultAuthRequest, () => codexConnection.process.exitCode);
}

new acp.AgentSideConnection(createAgent, acpJsonStream);