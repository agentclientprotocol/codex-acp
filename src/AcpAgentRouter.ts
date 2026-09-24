import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {z} from "zod";
import type {CodexAcpServer} from "./CodexAcpServer";
import {type AcpClientConnection, AcpV2Connection} from "./ACPSessionConnection";
import packageJson from "../package.json";
import {
    GOAL_CONTROL_METHOD, LEGACY_SET_SESSION_MODEL_METHOD,
    SESSION_STEERING_METHOD,
} from "./AcpExtensions";
import {ASYNC_TASK_STOP_METHOD} from "./async-tasks/AsyncTaskExtension";

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

/**
 * Builds the ACP router. It picks the v1 or v2 handler chain from the first `initialize`
 * request, and only the selected chain's `onConnect` runs for the connection.
 */
export function createAcpAgentRouter(
    createAgent: (connection: AcpClientConnection | AcpV2Connection) => CodexAcpServer,
): acpV2.AgentProtocolRouter {
    let codexAcpServer: CodexAcpServer | null = null;
    const getAgent = (): CodexAcpServer => {
        if (!codexAcpServer) {
            throw acp.RequestError.internalError("ACP agent is not connected");
        }
        return codexAcpServer;
    };
    const attachAgent = (agent: CodexAcpServer, signal: AbortSignal) => {
        codexAcpServer = agent;
        signal.addEventListener("abort", () => {
            if (codexAcpServer === agent) {
                codexAcpServer = null;
            }
        });
    };

    const v1Agent = acp.agent({name: packageJson.name})
        .onConnect((connection) => attachAgent(createAgent(connection.client), connection.signal))
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
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent().extMethod(GOAL_CONTROL_METHOD, ctx.params));

    const v2Agent = acpV2.agent({name: packageJson.name})
        .onConnect((connection) => attachAgent(createAgent(new AcpV2Connection(connection.client)), connection.signal))
        .onRequest(acpV2.methods.agent.initialize, (ctx) => getAgent().initializeV2(ctx.params))
        // No `session/load`: v2 folds it into `session/resume` with `replayFrom`.
        .onRequest(acpV2.methods.agent.session.new, (ctx) => getAgent().newSessionV2(ctx.params))
        .onRequest(acpV2.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acpV2.methods.agent.session.delete, (ctx) => getAgent().deleteSession(ctx.params))
        .onRequest(acpV2.methods.agent.session.resume, (ctx) => getAgent().resumeSessionV2(ctx.params))
        .onRequest(acpV2.methods.agent.session.close, (ctx) => getAgent().closeSession(ctx.params))
        // No `session/set_mode`: v2 removed the modes API; modes are config options.
        .onRequest(acpV2.methods.agent.session.setConfigOption, (ctx) => getAgent().setSessionConfigOptionV2(ctx.params))
        // The v1-only `authentication/status|logout` extensions are not registered on v2.
        .onRequest(acpV2.methods.agent.auth.login, (ctx) => getAgent().authenticateV2(ctx.params, ctx.requestId))
        .onRequest(acpV2.methods.agent.auth.logout, (ctx) => getAgent().logoutV2(ctx.params))
        .onRequest(acpV2.methods.agent.session.prompt, (ctx) => getAgent().promptV2(ctx.params));

    return acpV2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent);
}
