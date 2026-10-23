import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {z} from "zod";
import type {CodexAcpServer} from "./CodexAcpServer";
import {type AcpClientConnection, AcpV2Connection} from "./ACPSessionConnection";
import packageJson from "../package.json";
import {AcpResponseDelivery} from "./AcpResponseDelivery";
import {
    GOAL_CONTROL_METHOD, LEGACY_SET_SESSION_MODEL_METHOD,
    SESSION_STEERING_METHOD,
} from "./AcpExtensions";
import {ASYNC_TASK_STOP_METHOD} from "./async-tasks/AsyncTaskExtension";
import {CODEX_HOOKS_LIST_METHOD, CODEX_HOOKS_TRUST_METHOD} from "./CodexHookTrust";
import {
    SESSION_ARCHIVE_METHOD,
    SESSION_LIST_SUBSCRIBE_METHOD,
    SESSION_LIST_UNSUBSCRIBE_METHOD,
    SESSION_RENAME_METHOD,
    SESSION_UNARCHIVE_METHOD,
    sessionArchiveParamsParser,
    sessionListSubscriptionParamsParser,
    sessionRenameParamsParser,
} from "./SessionIndex";

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

const hooksListParamsParser = z.object({cwd: z.string().trim().min(1)});
const hooksTrustParamsParser = z.object({
    cwd: z.string().trim().min(1),
    hooks: z.array(z.object({key: z.string().min(1), currentHash: z.string().min(1)})).min(1),
});

/**
 * Builds the ACP router. It picks the v1 or v2 handler chain from the first `initialize`
 * request, and only the selected chain's `onConnect` runs for the connection.
 */
export function createAcpAgentRouter(
    createAgent: (connection: AcpClientConnection | AcpV2Connection) => CodexAcpServer,
): Pick<acpV2.AgentProtocolRouter, "connect"> {
    return {
        connect(stream, options) {
            const responses = new AcpResponseDelivery();
            const connection = createRouter(createAgent, responses).connect(responses.observe(stream), options);
            void connection.closed.then(() => responses.dispose());
            return connection;
        },
    };
}

function createRouter(
    createAgent: (connection: AcpClientConnection | AcpV2Connection) => CodexAcpServer,
    responses: AcpResponseDelivery,
): acpV2.AgentProtocolRouter {
    let codexAcpServer: CodexAcpServer | null = null;
    const getAgent = (params?: {sessionId?: unknown}): CodexAcpServer => {
        if (!codexAcpServer) {
            throw acp.RequestError.internalError("ACP agent is not connected");
        }
        if (typeof params?.sessionId === "string") codexAcpServer.assertSessionMutationAllowed(params.sessionId);
        return codexAcpServer;
    };
    type SetupState = {tail: Promise<void>; publication: Promise<void>; epoch: number; pending: number};
    const setups = new Map<string, SetupState>();
    const setup = <T>(sessionId: string, requestId: acpV2.JsonRpcId, operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
        const agent = getAgent({sessionId});
        if (!agent.usesStandardSubagents()) return operation();
        const assertCurrent = agent.captureSessionSetup(sessionId);
        const state = setups.get(sessionId) ?? {tail: Promise.resolve(), publication: Promise.resolve(), epoch: 0, pending: 0};
        setups.set(sessionId, state);
        state.pending++;
        const finish = () => {
            if (--state.pending === 0 && setups.get(sessionId) === state) setups.delete(sessionId);
        };
        let resolve!: (response: T) => void;
        let reject!: (error: unknown) => void;
        const response = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
        const task = state.tail.catch(() => {}).then(async () => {
            let registered = false;
            try {
                // A publication may start while this task is yielding to an earlier resolved promise.
                for (;;) {
                    const publication = state.publication;
                    await publication;
                    if (publication === state.publication) break;
                }
                if (signal.aborted) throw new acp.RequestError(-32800, "Session setup was cancelled");
                assertCurrent();
                const epoch = ++state.epoch;
                responses.afterWrite(requestId, () => {
                    if (epoch === state.epoch) state.publication = agent.afterSessionSetupResponse(sessionId);
                    void state.publication.then(finish, finish);
                });
                registered = true;
                resolve(await operation());
            } catch (error) {
                reject(error);
                if (!registered) finish();
            }
        });
        // Do not wait for delivery here: two requests in one batch share a response write.
        state.tail = task;
        return response;
    };
    const attachAgent = (agent: CodexAcpServer, signal: AbortSignal) => {
        codexAcpServer = agent;
        signal.addEventListener("abort", () => {
            setups.clear();
            agent.sessionIndex.dispose();
            if (codexAcpServer === agent) {
                codexAcpServer = null;
            }
        });
    };

    const v1Agent = acp.agent({name: packageJson.name})
        .onConnect((connection) => attachAgent(createAgent(connection.client), connection.signal))
        .onRequest(acp.methods.agent.initialize, (ctx) => getAgent().initialize(ctx.params))
        .onRequest(acp.methods.agent.session.new, (ctx) => getAgent().newSession(ctx.params))
        .onRequest(acp.methods.agent.session.load, (ctx) => setup(ctx.params.sessionId, ctx.requestId, () => getAgent(ctx.params).loadSession(ctx.params), ctx.signal))
        .onRequest(acp.methods.agent.session.fork, (ctx) => getAgent(ctx.params).forkSession(ctx.params))
        .onRequest(acp.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.delete, (ctx) => getAgent(ctx.params).deleteSession(ctx.params))
        .onRequest(acp.methods.agent.session.resume, (ctx) => setup(ctx.params.sessionId, ctx.requestId, () => getAgent(ctx.params).resumeSession(ctx.params), ctx.signal))
        .onRequest(acp.methods.agent.session.close, (ctx) => getAgent(ctx.params).closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.setMode, (ctx) => getAgent(ctx.params).setSessionMode(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => getAgent(ctx.params).setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.authenticate, (ctx) => getAgent().authenticate(ctx.params, ctx.requestId))
        .onRequest(acp.methods.agent.logout, (ctx) => getAgent().logout(ctx.params))
        .onRequest(acp.methods.agent.providers.list, (ctx) => getAgent().listProviders(ctx.params))
        .onRequest(acp.methods.agent.providers.set, (ctx) => getAgent().setProvider(ctx.params))
        .onRequest(acp.methods.agent.providers.disable, (ctx) => getAgent().disableProvider(ctx.params))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => getAgent(ctx.params).prompt(ctx.params, ctx.signal))
        .onNotification(acp.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params))
        .onRequest("authentication/status", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/status", ctx.params))
        .onRequest("authentication/logout", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/logout", ctx.params))
        .onRequest(LEGACY_SET_SESSION_MODEL_METHOD, legacySetSessionModelParamsParser, (ctx) => getAgent(ctx.params).extMethod(LEGACY_SET_SESSION_MODEL_METHOD, ctx.params))
        .onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAgent(ctx.params).extMethod(SESSION_STEERING_METHOD, ctx.params))
        .onRequest(ASYNC_TASK_STOP_METHOD, asyncTaskStopParamsParser, (ctx) => getAgent(ctx.params).extMethod(ASYNC_TASK_STOP_METHOD, ctx.params))
        .onRequest(CODEX_HOOKS_LIST_METHOD, hooksListParamsParser, (ctx) => getAgent().listHooks(ctx.params.cwd))
        .onRequest(CODEX_HOOKS_TRUST_METHOD, hooksTrustParamsParser, (ctx) => getAgent().trustHooks(ctx.params.cwd, ctx.params.hooks))
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent(ctx.params).extMethod(GOAL_CONTROL_METHOD, ctx.params))
        .onRequest(SESSION_RENAME_METHOD, sessionRenameParamsParser, (ctx) => getAgent(ctx.params).sessionIndex.rename(ctx.params))
        .onRequest(SESSION_ARCHIVE_METHOD, sessionArchiveParamsParser, (ctx) => getAgent(ctx.params).sessionIndex.setArchived(ctx.params, true))
        .onRequest(SESSION_UNARCHIVE_METHOD, sessionArchiveParamsParser, (ctx) => getAgent(ctx.params).sessionIndex.setArchived(ctx.params, false))
        .onRequest(SESSION_LIST_SUBSCRIBE_METHOD, sessionListSubscriptionParamsParser, (ctx) => getAgent().sessionIndex.subscribeList(ctx.params))
        .onRequest(SESSION_LIST_UNSUBSCRIBE_METHOD, sessionListSubscriptionParamsParser, (ctx) => getAgent().sessionIndex.unsubscribeList(ctx.params));

    const v2Agent = acpV2.agent({name: packageJson.name})
        .onConnect((connection) => attachAgent(createAgent(new AcpV2Connection(connection.client)), connection.signal))
        .onRequest(acpV2.methods.agent.initialize, (ctx) => getAgent().initializeV2(ctx.params))
        // No `session/load`: v2 folds it into `session/resume` with `replayFrom`.
        .onRequest(acpV2.methods.agent.session.new, (ctx) => getAgent().newSessionV2(ctx.params))
        .onRequest(acpV2.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acpV2.methods.agent.session.delete, (ctx) => getAgent(ctx.params).deleteSession(ctx.params))
        .onRequest(acpV2.methods.agent.session.resume, (ctx) => setup(ctx.params.sessionId, ctx.requestId, () => getAgent(ctx.params).resumeSessionV2(ctx.params), ctx.signal))
        .onRequest(acpV2.methods.agent.session.fork, (ctx) => getAgent(ctx.params).forkSessionV2(ctx.params))
        .onRequest(acpV2.methods.agent.session.close, (ctx) => getAgent(ctx.params).closeSession(ctx.params))
        // No `session/set_mode`: v2 removed the modes API; modes are config options.
        .onRequest(acpV2.methods.agent.session.setConfigOption, (ctx) => getAgent(ctx.params).setSessionConfigOptionV2(ctx.params))
        // The v1-only `authentication/status|logout` extensions are not registered on v2.
        .onRequest(acpV2.methods.agent.auth.login, (ctx) => getAgent().authenticateV2(ctx.params, ctx.requestId))
        .onRequest(acpV2.methods.agent.auth.logout, (ctx) => getAgent().logoutV2(ctx.params))
        .onRequest(acpV2.methods.agent.session.prompt, (ctx) => getAgent(ctx.params).promptV2(ctx.params, ctx.signal))
        .onNotification(acpV2.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params))
        .onRequest(acpV2.methods.agent.providers.list, (ctx) => getAgent().listProviders(ctx.params))
        .onRequest(acpV2.methods.agent.providers.set, (ctx) => getAgent().setProvider(ctx.params))
        .onRequest(acpV2.methods.agent.providers.disable, (ctx) => getAgent().disableProvider(ctx.params))
        .onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAgent(ctx.params).extMethod(SESSION_STEERING_METHOD, ctx.params))
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent(ctx.params).extMethod(GOAL_CONTROL_METHOD, ctx.params))
        .onRequest(ASYNC_TASK_STOP_METHOD, asyncTaskStopParamsParser, (ctx) => getAgent(ctx.params).extMethod(ASYNC_TASK_STOP_METHOD, ctx.params))
        .onRequest(SESSION_RENAME_METHOD, sessionRenameParamsParser, (ctx) => getAgent(ctx.params).sessionIndex.rename(ctx.params))
        .onRequest(SESSION_ARCHIVE_METHOD, sessionArchiveParamsParser, (ctx) => getAgent(ctx.params).sessionIndex.setArchived(ctx.params, true))
        .onRequest(SESSION_UNARCHIVE_METHOD, sessionArchiveParamsParser, (ctx) => getAgent(ctx.params).sessionIndex.setArchived(ctx.params, false))
        .onRequest(SESSION_LIST_SUBSCRIBE_METHOD, sessionListSubscriptionParamsParser, (ctx) => getAgent().sessionIndex.subscribeList(ctx.params))
        .onRequest(SESSION_LIST_UNSUBSCRIBE_METHOD, sessionListSubscriptionParamsParser, (ctx) => getAgent().sessionIndex.unsubscribeList(ctx.params));

    return acpV2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent);
}
