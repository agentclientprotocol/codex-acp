#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {z} from "zod";
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
import {
    GOAL_CONTROL_METHOD, LEGACY_SET_SESSION_MODEL_METHOD,
    SESSION_STEERING_METHOD,
} from "./AcpExtensions";

const emptyExtensionParamsParser = z.preprocess(
    (params) => params ?? {},
    z.object({}).passthrough()
);

const legacySetSessionModelParamsParser = z.object({
    sessionId: z.string(),
    modelId: z.string(),
}).passthrough();

const sessionSteerParamsParser = z.object({
    sessionId: z.string(),
    prompt: z.array(z.any()),
}).passthrough();

const goalControlParamsParser = z.object({
    sessionId: z.string(),
    action: z.enum(["pause", "clear"]),
}).passthrough();

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
    runCodexCli(process.env["CODEX_PATH"], args)
        .then((exitCode) => process.exit(exitCode))
        .catch((error) => {
            console.error("Codex CLI error:", error.message);
            process.exit(1);
        });
} else {
    startAcpServer();
}

function startAcpServer() {
    const codexPath = process.env["CODEX_PATH"];
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

    const maxStderrTailChars = 2 * 1024;
    let stderr = "";
    codexConnection.process.stderr.addListener("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-maxStderrTailChars);
    });

    process.stdin.on("close", () => {
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

    function createAgent(connection: acp.AgentContext): CodexAcpServer {
        const appServerClient = new CodexAppServerClient(codexConnection.connection);
        const codexClient = new CodexAcpClient(appServerClient, config, modelProvider);
        return new CodexAcpServer(connection, codexClient, defaultAuthRequest, () => codexConnection.process.exitCode, () => stderr);
    }

    let codexAcpServer: CodexAcpServer | null = null;
    const getAgent = (): CodexAcpServer => {
        if (!codexAcpServer) {
            throw acp.RequestError.internalError("ACP agent is not connected");
        }
        return codexAcpServer;
    };

    acp.agent({name: packageJson.name})
        .onConnect((connection) => {
            const agent = createAgent(connection.client);
            codexAcpServer = agent;
            connection.signal.addEventListener("abort", () => {
                if (codexAcpServer === agent) {
                    codexAcpServer = null;
                }
            });
        })
        .onRequest(acp.methods.agent.initialize, (ctx) => getAgent().initialize(ctx.params))
        .onRequest(acp.methods.agent.session.new, (ctx) => getAgent().newSession(ctx.params))
        .onRequest(acp.methods.agent.session.load, (ctx) => getAgent().loadSession(ctx.params))
        .onRequest(acp.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.delete, (ctx) => getAgent().deleteSession(ctx.params))
        .onRequest(acp.methods.agent.session.resume, (ctx) => getAgent().resumeSession(ctx.params))
        .onRequest(acp.methods.agent.session.close, (ctx) => getAgent().closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.setMode, (ctx) => getAgent().setSessionMode(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => getAgent().setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.authenticate, (ctx) => getAgent().authenticate(ctx.params))
        .onRequest(acp.methods.agent.logout, (ctx) => getAgent().logout(ctx.params))
        .onRequest(acp.methods.agent.providers.list, (ctx) => getAgent().listProviders(ctx.params))
        .onRequest(acp.methods.agent.providers.set, (ctx) => getAgent().setProvider(ctx.params))
        .onRequest(acp.methods.agent.providers.disable, (ctx) => getAgent().disableProvider(ctx.params))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => getAgent().prompt(ctx.params, ctx.signal))
        .onNotification(acp.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params))
        .onRequest("authentication/status", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/status", ctx.params))
        .onRequest("authentication/logout", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/logout", ctx.params))
        .onRequest(LEGACY_SET_SESSION_MODEL_METHOD, legacySetSessionModelParamsParser, (ctx) => getAgent().extMethod(LEGACY_SET_SESSION_MODEL_METHOD, ctx.params))
        .onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAgent().extMethod(SESSION_STEERING_METHOD, ctx.params))
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent().extMethod(GOAL_CONTROL_METHOD, ctx.params))
        .connect(acpJsonStream);
}
