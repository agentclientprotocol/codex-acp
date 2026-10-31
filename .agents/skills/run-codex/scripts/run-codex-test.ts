#!/usr/bin/env tsx
/** Real app-server/ACP probe. Never approves a permission request. */
import fs from "node:fs";
import {parseArgs} from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import {CodexAcpClient, type JsonObject} from "../../../../src/CodexAcpClient";
import {CodexAppServerClient} from "../../../../src/CodexAppServerClient";
import {startCodexConnection} from "../../../../src/CodexJsonRpcConnection";
import {CodexAcpServer} from "../../../../src/CodexAcpServer";
import type {AcpClientConnection} from "../../../../src/ACPSessionConnection";

const {values} = parseArgs({options: {
    prompt: {type: "string", short: "p"},
    cwd: {type: "string", short: "c", default: process.cwd()},
    output: {type: "string", short: "o", default: "all"},
    json: {type: "boolean", default: false},
    model: {type: "string", short: "m"},
    "list-models": {type: "boolean", default: false},
    "mcp-servers": {type: "string"},
    help: {type: "boolean", short: "h", default: false},
}});

if (values.help) {
    console.log(`Usage: npm run codex-test -- [options]
  -p, --prompt <text>       Prompt (required unless listing models)
  -c, --cwd <path>          Session working directory
  -o, --output <type>       all, codex, acp, summary (default: all)
  -m, --model <id[effort]>   Exact ACP model ID from --list-models
      --list-models        Read the live model catalog without starting a turn
      --mcp-servers <file>  JSON array of ACP MCP server entries
      --json               Emit JSON lines only
  -h, --help               Show help
Uses the bundled Codex unless CODEX_PATH is set; forwards CODEX_CONFIG.
Permission requests are cancelled and make the run fail.`);
} else {
    await main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

async function main(): Promise<void> {
    if (!values.prompt && !values["list-models"]) throw new Error("--prompt or --list-models is required");
    if (!["all", "codex", "acp", "summary"].includes(values.output)) throw new Error("Invalid --output");
    const config: unknown = JSON.parse(process.env["CODEX_CONFIG"] ?? "{}");
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("CODEX_CONFIG must be an object");
    const mcpServers: acp.McpServer[] = values["mcp-servers"]
        ? JSON.parse(fs.readFileSync(values["mcp-servers"], "utf8")) : [];
    if (!Array.isArray(mcpServers)) throw new Error("--mcp-servers must contain an array");
    const emit = (type: string, data: unknown) => console.log(values.json
        ? JSON.stringify({type, data}) : `[${type}] ${JSON.stringify(data, null, 2)}`);
    const connection = startCodexConnection(process.env["CODEX_PATH"]);
    const client = new CodexAppServerClient(connection.connection);
    const adapter = new CodexAcpClient(client, config as JsonObject);
    let codexEvents = 0;
    let acpEvents = 0;
    let permissionRequests = 0;
    const acpConnection: AcpClientConnection = {
        notify: async (method: string, params: unknown) => {
            acpEvents++;
            if (values.output === "all" || values.output === "acp") emit("acp", {method, params});
        },
        request: async (method: string) => {
            if (method === acp.methods.client.session.requestPermission) {
                permissionRequests++;
                emit("permission-cancelled", {method});
                return {outcome: {outcome: "cancelled"}} as never;
            }
            throw new Error(`Harness does not implement client request ${method}`);
        },
    };
    const agent = new CodexAcpServer(acpConnection, adapter, undefined, () => connection.process.exitCode);
    client.onClientTransportEvent(event => {
        codexEvents++;
        if (values.output === "all" || values.output === "codex") emit("codex", event);
    });
    try {
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});
        const models = await adapter.fetchAvailableModels();
        const available = models.filter(model => !model.hidden).flatMap(model =>
            model.supportedReasoningEfforts.map(({reasoningEffort}) => ({
                modelId: `${model.id}[${reasoningEffort}]`,
                model: model.model,
                isDefault: model.isDefault && reasoningEffort === model.defaultReasoningEffort,
            })));
        if (values["list-models"]) {
            emit("models", available);
            return;
        }
        if (values.model && !available.some(model => model.modelId === values.model)) {
            throw new Error(`Model ${values.model} is not advertised; use --list-models`);
        }
        if ((await adapter.readAuthRequirement()).required) throw new Error("Authentication required. Login to Codex first.");
        const session = await agent.newSession({cwd: values.cwd, mcpServers, _meta: {mcpStartupAwaitTimeoutMs: 30_000}});
        if (values.model) await agent.unstable_setSessionModel({sessionId: session.sessionId, modelId: values.model});
        emit("session", {sessionId: session.sessionId, model: agent.getSessionState(session.sessionId).currentModelId});
        const start = Date.now();
        const response = await agent.prompt({sessionId: session.sessionId, prompt: [{type: "text", text: values.prompt!}]});
        emit("summary", {response, durationMs: Date.now() - start, codexEvents, acpEvents, permissionRequests});
        await agent.closeSession({sessionId: session.sessionId});
        if (permissionRequests) throw new Error("Permission requests were cancelled; validation did not pass");
    } finally {
        connection.connection.end();
        connection.process.kill();
    }
}
