#!/usr/bin/env node
import {runInternalProcessHelper} from "./CodexProcessHelpers";
import type * as AcpTypes from "@agentclientprotocol/sdk";
import type {CodexProcessState, CodexAcpServer as CodexAcpServerType} from "./CodexAcpServer";

await runInternalProcessHelper();

const {SESSION_FILE_REVERT_METHOD, sessionFileRevertParser} = await import("./SessionFileRevert");
const {SESSION_QUEUE_METHOD, parseSessionQueueRequest} = await import("./SessionQueue");
const {SESSION_SEARCH_METHOD, SESSION_ATTACHMENTS_METHOD, sessionSearchParser, sessionAttachmentsParser} = await import("./SessionDiscovery");
const {SESSION_ARCHIVE_METHOD, SESSION_UNARCHIVE_METHOD, sessionArchiveParser} = await import("./SessionArchive");

const acp = await import("@agentclientprotocol/sdk");
const {z} = await import("zod");
const {startCodexConnection} = await import("./CodexJsonRpcConnection");
const {CodexAcpServer} = await import("./CodexAcpServer");
const {createJsonStream} = await import("./StdUtils");
const {isCodexAuthRequest} = await import("./CodexAuthMethod");
const {CodexAcpClient} = await import("./CodexAcpClient");
const {CodexAppServerClient} = await import("./CodexAppServerClient");
const {default: packageJson} = await import("../package.json");
const {logger} = await import("./Logger");
const {runLoginCommand} = await import("./login");
const {runCodexCli} = await import("./CodexCli");
const {prepareCodexHookConfig} = await import("./CodexHookConfig");
const {CODEX_HOOKS_LIST_METHOD, CODEX_HOOKS_TRUST_METHOD} = await import("./CodexHookTrust");
const {
    GOAL_CONTROL_METHOD, LEGACY_SET_SESSION_MODEL_METHOD,
    SESSION_STEERING_METHOD,
} = await import("./AcpExtensions");
const {ASYNC_TASK_STOP_METHOD} = await import("./async-tasks/AsyncTaskExtension");

const {RUNTIME_READ_METHOD, RUNTIME_CONTROL_METHOD, runtimeReadParser, runtimeControlParser} = await import("./SessionRuntime");
const {SESSION_REWIND_METHOD} = await import("./SessionRewind");

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

const asyncTaskStopParamsParser = z.object({
    sessionId: z.string().trim().min(1),
    asyncTaskId: z.string().trim().min(1),
}).passthrough();

const sessionHistoryPointParser = z.object({
    messageId: z.string().trim().min(1),
    messageFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    messageOccurrence: z.number().int().positive(),
});
const sessionRewindParamsParser = z.object({
    sessionId: z.string().trim().min(1),
    beforeMessage: sessionHistoryPointParser,
    resumeAtMessage: sessionHistoryPointParser.optional(),
}).passthrough();

const hooksListParamsParser = z.object({cwd: z.string().trim().min(1)});
const hooksTrustParamsParser = z.object({
    cwd: z.string().trim().min(1),
    hooks: z.array(z.object({key: z.string().min(1), currentHash: z.string().min(1)})).min(1),
});

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
    const hookConfig = prepareCodexHookConfig(config);
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

    const codexProcessState: CodexProcessState = {
        connection: startCodexConnection(codexPath, undefined, hookConfig.appServerStartupArgs),
        codexPath,
        config: hookConfig.sessionConfig,
        appServerStartupArgs: hookConfig.appServerStartupArgs,
        modelProvider,
        stderr: "",
    };

    process.stdin.on("close", () => {
        codexProcessState.connection.process.stdin.end();
        // Kill the codex process if it doesn't exit naturally
        setTimeout(() => {
            if (!codexProcessState.connection.process.killed) {
                logger.log("Codex still running 2s after stdin closed; terminating process");
                codexProcessState.connection.process.kill();
            }
        }, 2000);
    });

    const acpJsonStream = createJsonStream(process.stdin, process.stdout);

    function createAgent(connection: AcpTypes.AgentContext): CodexAcpServerType {
        const appServerClient = new CodexAppServerClient(codexProcessState.connection.connection);
        const codexClient = new CodexAcpClient(appServerClient, hookConfig.sessionConfig, modelProvider);
        return new CodexAcpServer(
            connection,
            codexClient,
            defaultAuthRequest,
            undefined,
            undefined,
            codexProcessState,
        );
    }

    let codexAcpServer: CodexAcpServerType | null = null;
    const getAgent = (): CodexAcpServerType => {
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
        .onRequest(acp.methods.agent.session.fork, (ctx) => getAgent().forkSession(ctx.params))
        .onRequest(acp.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.delete, (ctx) => getAgent().deleteSession(ctx.params))
        .onRequest(acp.methods.agent.session.resume, (ctx) => getAgent().resumeSession(ctx.params))
        .onRequest(acp.methods.agent.session.close, (ctx) => getAgent().closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.setMode, (ctx) => getAgent().setSessionMode(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => getAgent().setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.authenticate, (ctx) => getAgent().authenticate(ctx.params, ctx.requestId))
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
        .onRequest(ASYNC_TASK_STOP_METHOD, asyncTaskStopParamsParser, (ctx) => getAgent().extMethod(ASYNC_TASK_STOP_METHOD, ctx.params))
        .onRequest(SESSION_FILE_REVERT_METHOD, sessionFileRevertParser, (ctx) => getAgent().revertFiles(ctx.params))
        .onRequest(SESSION_QUEUE_METHOD, z.unknown().transform(value => parseSessionQueueRequest(value)), (ctx) => getAgent().manageSessionQueue(ctx.params, ctx.signal))
        .onRequest(SESSION_SEARCH_METHOD, sessionSearchParser, (ctx) => getAgent().searchSessionHistory(ctx.params))
        .onRequest(SESSION_ATTACHMENTS_METHOD, sessionAttachmentsParser, (ctx) => getAgent().manageSessionAttachments(ctx.params))
        .onRequest(SESSION_ARCHIVE_METHOD, sessionArchiveParser, (ctx) => getAgent().archiveSession(ctx.params.sessionId, true))
        .onRequest(SESSION_UNARCHIVE_METHOD, sessionArchiveParser, (ctx) => getAgent().archiveSession(ctx.params.sessionId, false))
        .onRequest(RUNTIME_READ_METHOD, runtimeReadParser, (ctx) => getAgent().readSessionRuntime(ctx.params, ctx.signal))
        .onRequest(RUNTIME_CONTROL_METHOD, runtimeControlParser, (ctx) => getAgent().controlSessionRuntime(ctx.params))
        .onRequest(SESSION_REWIND_METHOD, sessionRewindParamsParser, (ctx) => getAgent().extMethod(SESSION_REWIND_METHOD, ctx.params))
        .onRequest(CODEX_HOOKS_LIST_METHOD, hooksListParamsParser, (ctx) => getAgent().listHooks(ctx.params.cwd))
        .onRequest(CODEX_HOOKS_TRUST_METHOD, hooksTrustParamsParser, (ctx) => getAgent().trustHooks(ctx.params.cwd, ctx.params.hooks))
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent().extMethod(GOAL_CONTROL_METHOD, ctx.params))
        .connect(acpJsonStream);
}
