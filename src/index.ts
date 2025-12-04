#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexACPAgent} from "./CodexACPAgent";
import {createJsonStream} from "./StdUtils";

const codexPath = process.env["CODEX_PATH"] ?? "codex";
const logPath = process.env["APP_SERVER_LOGS"];

const appServerConnection = startCodexConnection(codexPath, logPath)
const acpJsonStream = createJsonStream(process.stdin, process.stdout);

new acp.AgentSideConnection(
    (acpConnection) => new CodexACPAgent(acpConnection, appServerConnection),
    acpJsonStream
);