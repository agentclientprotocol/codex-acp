#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexACPAgent} from "./CodexACPAgent";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";

const codexPath = process.env["CODEX_PATH"] ?? "codex";
const logPath = process.env["APP_SERVER_LOGS"];

const appServerConnection = startCodexConnection(codexPath, logPath)
const acpJsonStream = createJsonStream(process.stdin, process.stdout);

function createAgent(connection: acp.AgentSideConnection): CodexACPAgent {
    const configString = process.env["CODEX_CONFIG"];
    const config = configString ? JSON.parse(configString) : undefined;
    const modelProvider= process.env["MODEL_PROVIDER"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const parsedRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedRequest && isCodexAuthRequest(parsedRequest) ? parsedRequest : undefined;
    const appServerClient = new CodexAppServerClient(appServerConnection);
    const codexClient = new CodexAcpClient(appServerClient, config, modelProvider)
    return new CodexACPAgent(connection, codexClient, defaultAuthRequest);
}

new acp.AgentSideConnection(createAgent, acpJsonStream);