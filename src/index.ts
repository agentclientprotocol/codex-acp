#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexACPAgent} from "./CodexACPAgent";
import {createJsonStream} from "./StdUtils";

const appServerConnection = startCodexConnection()
const acpJsonStream = createJsonStream(process.stdin, process.stdout);

new acp.AgentSideConnection(
    (acpConnection) => new CodexACPAgent(acpConnection, appServerConnection),
    acpJsonStream
);
