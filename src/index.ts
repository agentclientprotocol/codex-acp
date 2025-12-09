#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexACPAgent} from "./CodexACPAgent";
import {createJsonStream} from "./StdUtils";

const codexPath = process.env["CODEX_PATH"] ?? "codex";
const logPath = process.env["APP_SERVER_LOGS"];

const appServerConnection = startCodexConnection(codexPath, logPath)
const acpJsonStream = createJsonStream(process.stdin, process.stdout);

function createAgent(connection: acp.AgentSideConnection): CodexACPAgent {
    const configString = process.env["CODEX_CONFIG"];
    const config = configString ? JSON.parse(configString) : undefined;
    const modelProvider = process.env["MODEL_PROVIDER"];
    return new CodexACPAgent(connection, appServerConnection, config, modelProvider);
}

new acp.AgentSideConnection(createAgent, acpJsonStream);