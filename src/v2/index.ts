#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {z} from "zod";
import {Readable, Writable} from "node:stream";
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexAcpServer, type CodexProcessState} from "../CodexAcpServer";
import {isCodexAuthRequest} from "../CodexAuthMethod";
import {CodexAcpClient} from "../CodexAcpClient";
import {CodexAppServerClient} from "../CodexAppServerClient";
import packageJson from "../../package.json";
import {logger} from "../Logger";
import {runLoginCommand} from "../login";
import {runCodexCli} from "../CodexCli";
import {
    GOAL_CONTROL_METHOD,
    SESSION_STEERING_METHOD,
} from "../AcpExtensions";
import {
    CodexAcpV2Adapter,
    createLegacyClientConnection,
    V2SessionUpdateMapper,
} from "./CodexAcpV2Adapter";

const sessionSteerParamsParser = z.object({
    sessionId: z.string(),
    prompt: z.array(z.any()),
}).passthrough();

const goalControlParamsParser = z.discriminatedUnion("action", [
    z.object({
        sessionId: z.string(),
        action: z.literal("set"),
        objective: z.string().trim().min(1),
    }).passthrough(),
    z.object({
        sessionId: z.string(),
        action: z.enum(["pause", "resume", "clear"]),
    }).passthrough(),
]);

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name}-v2 ${packageJson.version}`);
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
    runCodexCli(process.env["CODEX_PATH"], args)
        .then((exitCode) => process.exit(exitCode))
        .catch((error) => {
            console.error("Codex CLI error:", error.message);
            process.exit(1);
        });
} else {
    startAcpV2Server();
}

function startAcpV2Server(): void {
    const codexPath = process.env["CODEX_PATH"];
    const configString = process.env["CODEX_CONFIG"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const modelProvider = process.env["MODEL_PROVIDER"];
    const config = configString ? JSON.parse(configString) : undefined;
    const parsedAuthRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedAuthRequest && isCodexAuthRequest(parsedAuthRequest) ? parsedAuthRequest : undefined;

    logger.log("ACP v2 startup", {
        name: packageJson.name,
        version: packageJson.version,
        codexPath,
        modelProvider: modelProvider ?? null,
        codexConfig: config ?? null,
    });

    const codexProcessState: CodexProcessState = {
        connection: startCodexConnection(codexPath),
        codexPath,
        config,
        modelProvider,
        stderr: "",
    };

    process.stdin.on("close", () => {
        codexProcessState.connection.process.stdin.end();
        setTimeout(() => {
            if (!codexProcessState.connection.process.killed) {
                logger.log("Codex still running 2s after stdin closed; terminating process");
                codexProcessState.connection.process.kill();
            }
        }, 2000);
    });

    const acpJsonStream = acp.ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    );
    let adapter: CodexAcpV2Adapter | null = null;
    const getAdapter = (): CodexAcpV2Adapter => {
        if (adapter === null) {
            throw acp.RequestError.internalError("ACP v2 agent is not connected");
        }
        return adapter;
    };

    acp.agent({name: `${packageJson.name}-v2`})
        .onConnect((connection) => {
            const updateMapper = new V2SessionUpdateMapper();
            const appServerClient = new CodexAppServerClient(codexProcessState.connection.connection);
            const codexClient = new CodexAcpClient(appServerClient, config, modelProvider);
            const legacyAgent = new CodexAcpServer(
                createLegacyClientConnection(connection.client, updateMapper),
                codexClient,
                defaultAuthRequest,
                undefined,
                undefined,
                codexProcessState,
            );
            const connectedAdapter = new CodexAcpV2Adapter(legacyAgent, connection.client, updateMapper);
            adapter = connectedAdapter;
            connection.signal.addEventListener("abort", () => {
                if (adapter === connectedAdapter) {
                    adapter = null;
                }
            });
        })
        .onRequest(acp.methods.agent.initialize, (ctx) => getAdapter().initialize(ctx.params))
        .onRequest(acp.methods.agent.session.new, (ctx) => getAdapter().newSession(ctx.params))
        .onRequest(acp.methods.agent.session.list, (ctx) => getAdapter().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.delete, (ctx) => getAdapter().deleteSession(ctx.params))
        .onRequest(acp.methods.agent.session.resume, (ctx) => getAdapter().resumeSession(ctx.params))
        .onRequest(acp.methods.agent.session.close, (ctx) => getAdapter().closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => getAdapter().setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.auth.login, (ctx) => getAdapter().login(ctx.params, ctx.requestId))
        .onRequest(acp.methods.agent.auth.logout, (ctx) => getAdapter().logout(ctx.params))
        .onRequest(acp.methods.agent.providers.list, (ctx) => getAdapter().listProviders(ctx.params))
        .onRequest(acp.methods.agent.providers.set, (ctx) => getAdapter().setProvider(ctx.params))
        .onRequest(acp.methods.agent.providers.disable, (ctx) => getAdapter().disableProvider(ctx.params))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => getAdapter().prompt(ctx.params, ctx.signal))
        .onNotification(acp.methods.agent.session.cancel, (ctx) => getAdapter().cancel(ctx.params))
        .onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAdapter().extMethod(SESSION_STEERING_METHOD, ctx.params))
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAdapter().extMethod(GOAL_CONTROL_METHOD, ctx.params))
        .connect(acpJsonStream);
}
