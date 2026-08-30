import * as acp from "@agentclientprotocol/sdk";
import {RequestError, type SessionId, type SessionModeState} from "@agentclientprotocol/sdk";
import {CodexEventHandler, type CompletedPlan} from "./CodexEventHandler";
import {CodexApprovalHandler} from "./permissions/CodexApprovalHandler";
import {PermissionLifecycleContext} from "./permissions/lifecycle";
import {
    planImplementationApproved,
    planImplementationPermissionRequest,
    planImplementationToolCallId,
} from "./permissions/plan-review";
import {CodexElicitationHandler} from "./CodexElicitationHandler";
import {type CodexAuthRequest, getCodexAuthMethods, isCodexAuthRequest} from "./CodexAuthMethod";
import {clientSupportsUrlElicitation} from "./ElicitationCapabilities";
import {
    CodexAcpClient,
    type JsonObject,
    OPENAI_PROVIDER_ID,
    type SessionMetadata,
    type SessionMetadataWithThread,
    type UrlElicitationRequester
} from "./CodexAcpClient";
import {CodexAppServerClient, type McpStartupResult} from "./CodexAppServerClient";
import {type CodexConnection, startCodexConnection} from "./CodexJsonRpcConnection";
import {type AcpClientConnection, ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {InputModality, ReasoningEffort, ServerNotification} from "./app-server";
import type {Account, Model, ReasoningEffortOption, Thread, ThreadGoal, ThreadItem, UserInput} from "./app-server/v2";
import type {RateLimitsMap} from "./RateLimitsMap";
import {ModelId} from "./ModelId";
import {AgentMode, MODE_CONFIG_ID} from "./AgentMode";
import {
    COLLABORATION_MODE_CONFIG_ID,
    createCollaborationModeConfigOption,
    DEFAULT_COLLABORATION_MODE,
    parseCollaborationMode,
    PLAN_COLLABORATION_MODE,
} from "./CollaborationModeConfig";
import type {ModeKind} from "./app-server/ModeKind";
import {
    createModelConfigOption,
    createReasoningEffortConfigOption,
    findSupportedEffort,
    MODEL_CONFIG_ID,
    REASONING_EFFORT_CONFIG_ID,
} from "./ModelConfigOption";
import type {TokenCount} from "./TokenCount";
import {toPromptUsage} from "./TokenCount";
import {CodexCommands, GOAL_CONTINUATION_PROMPT} from "./CodexCommands";
import {SteeringQueue} from "./SteeringQueue";
import type {QuotaMeta} from "./QuotaMeta";
import {logger} from "./Logger";
import {sanitizeMcpServerName} from "./McpServerName";
import {createResponseItemHistoryFallbackUpdates} from "./ResponseItemHistoryFallback";
import {
    GOAL_CONTROL_ACTIONS,
    GOAL_CONTROL_METHOD,
    GOAL_EXTENSION_VERSION,
    isExtMethodRequest,
    KANDEV_GUARDED_TTY_CAPABILITY,
    KANDEV_GUARDED_TTY_CAPABILITY_METHOD,
    KANDEV_GUARDED_TTY_EXEC_METHOD,
    KANDEV_GUARDED_TTY_VERSION,
    LEGACY_GOAL_CONTROL_METHOD,
    LEGACY_SET_SESSION_MODEL_METHOD,
    type LegacyLoadSessionResponse,
    type LegacyNewSessionResponse,
    type LegacyResumeSessionResponse,
    type LegacySessionModelState,
    type LegacySetSessionModelRequest,
    type LegacySetSessionModelResponse,
    SESSION_STEERING_METHOD,
    type SessionSteeringResponse,
    type SessionSteerRequest,
    type KandevGuardedTtyCapabilityRequest,
    type KandevGuardedTtyCapabilityResponse,
    type KandevGuardedTtyExecReceipt,
    type KandevGuardedTtyExecRequest,
} from "./AcpExtensions";
import {
    createCollabAgentToolCallUpdate,
    createCommandExecutionCompleteUpdate,
    createCommandExecutionUpdate,
    createCompletedContextCompactionUpdate,
    createDynamicToolCallUpdate,
    createFileChangeUpdate,
    createImageGenerationUpdate,
    createImageViewUpdate,
    createMcpToolCallUpdate,
    createSubAgentActivityUpdate,
    formatWebSearchTitle,
} from "./CodexToolCallMapper";
import {
    clientSupportsBooleanConfigOptions,
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_OFF,
    FAST_MODE_ON,
    modelSupportsFast,
    resolveFastServiceTier,
} from "./FastModeConfig";
import packageJson from "../package.json";
import {isJetBrains2026_1Client} from "./JBUtils";
import {resolveTerminalOutputMode, type TerminalOutputMode} from "./TerminalOutputMode";
import {clientSupportsPlanUpdates} from "./PlanCapabilities";
import {
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
    createCodexMessagePhaseMeta,
    createUserMessageChunk,
} from "./ContentChunks";
import {sameThreadGoalSnapshot, type ThreadGoalSnapshot, toThreadGoalSnapshot,} from "./ThreadGoalSnapshot";
import {
    clientSupportsSubagents,
    type SubagentAwareSessionCapabilities,
} from "./subagents/AcpSubagents";
import {CodexSubagentEventRouter} from "./subagents/CodexSubagentEventRouter";
import {nameFromAgentPath} from "./subagents/CodexAgentPath";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {
    AIR_AGENT_FILE_CHANGE_REPORT_KEY,
    AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
    AIR_EXTENSION_CAPABILITIES_KEY,
    AIR_EXTENSION_VERSION,
    AIR_EXTENSION_VERSION_KEY,
    AIR_META_KEY,
    AIR_SESSION_FAILURE_KEY,
    clientSupportsAirCapability,
    JETBRAINS_META_KEY,
} from "./AirExtension";
import {
    type AgentFileChangeReport,
    type AgentFileChangeReportRequest,
    type AgentFileChangeReportUnavailableReason,
    createUnavailableAgentFileChangeReport,
    parseAgentFileChangeReportRequest,
} from "./AgentFileChangeReport";
import {
    createUndispatchedGuardedTtyReceipt,
    validateGuardedTtyArgv,
} from "./GuardedTtyExec";


export interface SessionState {
    sessionId: string,
    currentModelId: string,
    availableModels: Array<Model>,
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    supportedInputModalities: Array<InputModality>,
    agentMode: AgentMode,
    collaborationMode: ModeKind,
    currentTurnId: string | null;
    lastTokenUsage: TokenCount | null;
    totalTokenUsage: TokenCount | null;
    modelContextWindow: number | null;
    rateLimits: RateLimitsMap | null;
    account: Account | null;
    authConfigured: boolean;
    authProvider: string | null;
    cwd: string;
    additionalDirectories: string[];
    mcpServers?: Array<acp.McpServer>;
    fastModeEnabled: boolean;
    currentModelSupportsFast: boolean;
    sessionMcpServers?: Array<string>;
    terminalOutputMode: TerminalOutputMode;
    currentGoal?: ThreadGoalSnapshot | null;
    goalRevision: number;
    sessionTitle: string | null;
    sessionTitleSource: "unset" | "fallback" | "explicit" | "unknown";
    sessionFailure?: SessionFailure;
    subagents: CodexSubagentEventRouter;
}

export type SessionFailureCategory =
    | "connection" | "access" | "limit" | "request" | "service" | "unknown";

export type SessionFailureAction = "retry" | "login" | "new_session";

/**
 * How loudly the client should render the record. Absent on the wire means `error`, so an AIR build
 * that predates warning support keeps treating every record it receives as a failure.
 */
export type SessionFailureSeverity = "error" | "warning";

export interface SessionFailure {
    id: string;
    revision: number;
    category: SessionFailureCategory;
    severity: SessionFailureSeverity;
    title: string;
    details?: string;
    actions: SessionFailureAction[];
}

const CODEX_PROCESS_EXITED_ERROR_CODE = 1001;

function clientSupportsTypedSessionFailures(capabilities: acp.ClientCapabilities | null): boolean {
    return clientSupportsAirCapability(capabilities, AIR_SESSION_FAILURE_KEY);
}

function clientSupportsAgentFileChangeReports(capabilities: acp.ClientCapabilities | null): boolean {
    return clientSupportsAirCapability(capabilities, AIR_AGENT_FILE_CHANGE_REPORT_KEY);
}

interface ActiveAuthState {
    account: Account | null;
    authConfigured: boolean;
}

interface PendingMcpStartupSession {
    requestedServers: Set<string>;
    afterVersion: number;
}

interface PendingTurnStart {
    promise: Promise<string | null>;
    resolve: (turnId: string | null) => void;
}

interface ActivePrompt {
    completion: Promise<void>;
    closeSignal: Promise<null>;
    cancelSignal: Promise<null>;
    signal: AbortSignal;
    currentTurn: { threadId: string, turnId: string } | null;
    requestCancel: () => void;
    requestClose: () => void;
    complete: () => void;
}

export interface CodexProcessState {
    connection: CodexConnection;
    codexPath: string | undefined;
    config: JsonObject | undefined;
    modelProvider: string | undefined;
    stderr: string;
    stderrProcess?: CodexConnection["process"];
}

export class CodexAcpServer {
    private static readonly MODEL_NAME_TOKEN_OVERRIDES: Record<string, string> = {
        gpt: "GPT",
        mini: "Mini",
        codex: "Codex",
    };

    private codexAcpClient: CodexAcpClient;
    private readonly connection: AcpClientConnection;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;
    private readonly getRecentStderr: () => string;
    private readonly sessionFailureEpoch: string;
    private availableCommands: CodexCommands;
    private clientInfo: acp.Implementation | null;
    private clientCapabilities: acp.ClientCapabilities | null;
    private terminalOutputMode: TerminalOutputMode;
    private booleanConfigOptionsSupported: boolean;

    private readonly sessions: Map<string, SessionState>;
    private readonly pendingMcpStartupSessions: Map<string, PendingMcpStartupSession>;
    private readonly pendingTurnStarts: Map<string, PendingTurnStart>;
    private readonly activePrompts: Map<string, ActivePrompt>;
    private readonly steeringQueues: Map<string, SteeringQueue>;
    private readonly closingSessions: Map<string, number>;
    private readonly sessionGenerations: Map<string, number>;
    private readonly sessionOpenGenerations: Map<string, number>;
    private readonly goalControlGenerations: Map<string, number>;
    private readonly guardedTtyExecutions: Map<string, Set<AbortController>>;
    private readonly permissionLifecycleContexts: WeakMap<SessionState, PermissionLifecycleContext>;
    private readonly codexProcessState: CodexProcessState | null;
    private initializeRequest: acp.InitializeRequest | null = null;
    private providerUpdate: Promise<void> | null = null;

    constructor(
        connection: AcpClientConnection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
        getExitCode?: () => number | null,
        getRecentStderr?: () => string,
        codexProcessState?: CodexProcessState,
    ) {
        this.sessions = new Map();
        this.pendingMcpStartupSessions = new Map();
        this.pendingTurnStarts = new Map();
        this.activePrompts = new Map();
        this.steeringQueues = new Map();
        this.closingSessions = new Map();
        this.sessionGenerations = new Map();
        this.sessionOpenGenerations = new Map();
        this.goalControlGenerations = new Map();
        this.guardedTtyExecutions = new Map();
        this.permissionLifecycleContexts = new WeakMap();
        this.connection = connection;
        this.codexAcpClient = codexAcpClient;
        this.defaultAuthRequest = defaultAuthRequest ?? null;
        this.codexProcessState = codexProcessState ?? null;
        this.captureStderr();
        this.getExitCode = getExitCode ?? (() => this.codexProcessState?.connection.process.exitCode ?? null);
        this.getRecentStderr = getRecentStderr ?? (() => this.codexProcessState?.stderr ?? "");
        this.sessionFailureEpoch = randomUUID();
        this.clientInfo = null;
        this.clientCapabilities = null;
        this.terminalOutputMode = "terminal_output_delta";
        this.booleanConfigOptionsSupported = false;
        this.availableCommands = this.createAvailableCommands(codexAcpClient);
    }

    private createAvailableCommands(client: CodexAcpClient): CodexCommands {
        return new CodexCommands(
            this.connection,
            client,
            (operation) => this.runWithProcessCheck(operation),
            () => this.refreshSessionsAuthState(null)
        );
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        logger.log("Initialize request received");
        this.clientInfo = _params.clientInfo ?? null;
        this.clientCapabilities = _params.clientCapabilities ?? null;
        this.initializeRequest = _params;
        this.terminalOutputMode = resolveTerminalOutputMode(_params.clientCapabilities);
        this.booleanConfigOptionsSupported = clientSupportsBooleanConfigOptions(_params.clientCapabilities);
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize(_params));
        const sessionCapabilities: SubagentAwareSessionCapabilities = {
            resume: { },
            list: { },
            close: { },
            delete: { },
            fork: { },
            additionalDirectories: {},
            subagents: {},
        };
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            agentCapabilities: {
                auth: {
                    logout: {},
                },
                providers: {},
                loadSession: true,
                promptCapabilities: {
                    embeddedContext: true,
                    image: true
                },
                sessionCapabilities,
                mcpCapabilities: {
                    acp: false,
                    http: true,
                    sse: false
                }
            },
            authMethods: getCodexAuthMethods(_params.clientCapabilities),
            _meta: {
                steering: {
                    supported: true,
                },
                goal: {
                    version: GOAL_EXTENSION_VERSION,
                    controlMethod: GOAL_CONTROL_METHOD,
                    actions: [...GOAL_CONTROL_ACTIONS],
                },
                guardedTtyExec: {
                    capability: KANDEV_GUARDED_TTY_CAPABILITY,
                    version: KANDEV_GUARDED_TTY_VERSION,
                    capabilityMethod: KANDEV_GUARDED_TTY_CAPABILITY_METHOD,
                    execMethod: KANDEV_GUARDED_TTY_EXEC_METHOD,
                },
                [JETBRAINS_META_KEY]: {
                    [AIR_META_KEY]: {
                        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                        [AIR_EXTENSION_CAPABILITIES_KEY]: [
                            AIR_SESSION_FAILURE_KEY,
                            AIR_AGENT_FILE_CHANGE_REPORT_KEY,
                            AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
                        ],
                    },
                },
            },
        };
    }

    async extMethod(
        method: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
        const methodRequest = { method: method, params: params };
        if (!isExtMethodRequest(methodRequest)) {
            return {};
        }
        switch (methodRequest.method) {
            case "authentication/status":
                return await this.runWithProcessCheck(() => this.codexAcpClient.getAuthenticationStatus());
            case "authentication/logout": {
                await this.logout({});
                return {};
            }
            case LEGACY_SET_SESSION_MODEL_METHOD:
                return await this.unstable_setSessionModel(this.parseLegacySetSessionModelParams(methodRequest.params));
            case SESSION_STEERING_METHOD:
                return await this.executeOrQueueSteeringRequest(this.parseSessionSteerParams(methodRequest.params));
            case KANDEV_GUARDED_TTY_CAPABILITY_METHOD:
                return this.guardedTtyCapability(this.parseGuardedTtyCapabilityParams(methodRequest.params));
            case KANDEV_GUARDED_TTY_EXEC_METHOD:
                return await this.executeGuardedTtyExec(
                    this.parseGuardedTtyExecParams(methodRequest.params),
                    signal,
                );
            case GOAL_CONTROL_METHOD:
            case LEGACY_GOAL_CONTROL_METHOD: {
                const sessionState = this.sessions.get(methodRequest.params.sessionId);
                if (!sessionState) {
                    throw RequestError.invalidParams(undefined, `Unknown session: ${methodRequest.params.sessionId}`);
                }
                const sessionGeneration = this.getSessionGeneration(sessionState.sessionId);
                const goalControlGeneration = this.bumpGoalControlGeneration(sessionState.sessionId);
                if (methodRequest.params.action === "set") {
                    const objective = methodRequest.params.objective;
                    let updatedGoal: ThreadGoal | null = null;
                    const turnCompleted = await this.runWithProcessCheck(() => this.codexAcpClient.setGoal(
                        sessionState.sessionId,
                        objective,
                        undefined,
                        (goal) => {
                            updatedGoal = goal;
                        },
                    ));
                    if (turnCompleted === null && updatedGoal !== null) {
                        await this.startGoalContinuationIfCurrent(
                            sessionState,
                            sessionGeneration,
                            goalControlGeneration,
                            updatedGoal,
                        );
                    }
                } else if (methodRequest.params.action === "pause") {
                    const goal = await this.runWithProcessCheck(() => this.codexAcpClient.setGoalStatus(sessionState.sessionId, "paused"));
                    if (this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(goal), false);
                    }
                } else if (methodRequest.params.action === "resume") {
                    let updatedGoal: ThreadGoal | null = null;
                    const turnCompleted = await this.runWithProcessCheck(() => this.codexAcpClient.resumeGoal(
                        sessionState.sessionId,
                        undefined,
                        (goal) => {
                            updatedGoal = goal;
                        },
                    ));
                    if (updatedGoal !== null && this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(updatedGoal), false);
                    }
                    if (turnCompleted === null && updatedGoal !== null) {
                        await this.startGoalContinuationIfCurrent(
                            sessionState,
                            sessionGeneration,
                            goalControlGeneration,
                            updatedGoal,
                        );
                    }
                } else if (methodRequest.params.action === "clear") {
                    await this.runWithProcessCheck(() => this.codexAcpClient.clearGoal(sessionState.sessionId));
                    if (this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, null, false);
                    }
                }
                return {};
            }
        }
    }

    async checkAuthorization(){
        const authNeeded = await this.runWithProcessCheck(() => this.codexAcpClient.authRequired());
        logger.log("Auth requirement checked", {authRequired: authNeeded});
        if (authNeeded) {
            if (this.defaultAuthRequest) {
                logger.log("Authenticating with default auth request...", {
                    authRequest: this.defaultAuthRequest
                });
                await this.authenticate(this.defaultAuthRequest)
                logger.log("Authentication completed");
            } else {
                logger.log("Authentication required but no default auth request provided, return to IDE");
                throw RequestError.authRequired();
            }
        }
    }

    async getOrCreateSession(request: acp.NewSessionRequest | acp.ResumeSessionRequest): Promise<[SessionId, LegacySessionModelState, SessionModeState]> {
        try {
            return await this.tryCreateSession(request);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            await this.handleError(error);
            throw e;
        }
    }

    async handleError(e: Error){
        if (e.message.includes("log out") || e.message.includes("cloud requirements")) {
            await this.runWithProcessCheck(() => this.codexAcpClient.logout());
            await this.refreshSessionsAuthState(null);
            throw RequestError.internalError(`${(e.message)}\n\nYou have been logged out. Please try again.`);
        }
        const configPath = this.codexAcpClient.getHomePath() ?? "global";
        if (e.message.includes("load config")) {
            throw RequestError.internalError(`${e.message}\n\nCheck ${configPath} and project .codex directories, especially their config.toml files, or any CODEX_CONFIG override.`);
        }
    }

    private beginSessionOpen(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId);
        if (this.sessionIsClosing(sessionId)) {
            throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
        }
        this.sessionOpenGenerations.set(sessionId, generation);
        return generation;
    }

    private sessionOpenCanInstall(sessionId: string, generation: number): boolean {
        return !this.sessionIsClosing(sessionId) && this.getSessionGeneration(sessionId) === generation;
    }

    private async cleanupStaleSessionOpen(sessionId: string, generation: number): Promise<boolean> {
        if (this.sessionOpenGenerations.get(sessionId) === generation) {
            if (!this.sessionIsClosing(sessionId)) {
                this.bumpSessionGeneration(sessionId);
            }
            this.beginSessionCloseFence(sessionId);
            try {
                await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(sessionId));
            } catch (err) {
                logger.error(`Failed to close stale session open for ${sessionId}`, err);
            } finally {
                this.endSessionCloseFence(sessionId);
            }
            return true;
        }
        return false;
    }

    private async closeStaleSessionOpen(sessionId: string, generation: number): Promise<void> {
        await this.cleanupStaleSessionOpen(sessionId, generation);
        throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
    }

    private sessionIsClosing(sessionId: string): boolean {
        return (this.closingSessions.get(sessionId) ?? 0) > 0;
    }

    private beginSessionCloseFence(sessionId: string): void {
        this.closingSessions.set(sessionId, (this.closingSessions.get(sessionId) ?? 0) + 1);
    }

    private endSessionCloseFence(sessionId: string): void {
        const count = this.closingSessions.get(sessionId) ?? 0;
        if (count <= 1) {
            this.closingSessions.delete(sessionId);
            return;
        }
        this.closingSessions.set(sessionId, count - 1);
    }

    private getSessionGeneration(sessionId: string): number {
        return this.sessionGenerations.get(sessionId) ?? 0;
    }

    private bumpGoalControlGeneration(sessionId: string): number {
        const generation = (this.goalControlGenerations.get(sessionId) ?? 0) + 1;
        this.goalControlGenerations.set(sessionId, generation);
        return generation;
    }

    private bumpSessionGeneration(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId) + 1;
        this.sessionGenerations.set(sessionId, generation);
        return generation;
    }

    async tryCreateSession(
        request: acp.NewSessionRequest | acp.ResumeSessionRequest | acp.ForkSessionRequest,
        operation: "new" | "resume" | "fork" = "sessionId" in request ? "resume" : "new",
    ): Promise<[SessionId, LegacySessionModelState, SessionModeState]> {
        const existingSessionRequest = request as acp.ResumeSessionRequest | acp.ForkSessionRequest;
        const requestedSessionGeneration = operation === "resume"
            ? this.beginSessionOpen(existingSessionRequest.sessionId)
            : null;
        await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const mcpServerStartupVersion = requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;

        let sessionMetadata: SessionMetadata;
        let resumeSubscribed = false;
        if (operation === "resume") {
            const resumeRequest = request as acp.ResumeSessionRequest;
            logger.log(`Resume existing session: ${resumeRequest.sessionId}...`);
            try {
                sessionMetadata = await this.runWithProcessCheck(() =>
                    this.codexAcpClient.resumeSession(resumeRequest, () => {
                        resumeSubscribed = true;
                    })
                );
            } catch (err) {
                if (resumeSubscribed && requestedSessionGeneration !== null) {
                    await this.cleanupStaleSessionOpen(resumeRequest.sessionId, requestedSessionGeneration);
                }
                throw err;
            }
        } else if (operation === "fork") {
            const forkRequest = request as acp.ForkSessionRequest;
            logger.log(`Fork existing session: ${forkRequest.sessionId}...`);
            sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.forkSession(forkRequest));
        } else {
            logger.log(`Create new session...`);
            sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.newSession(request as acp.NewSessionRequest));
        }

        const {sessionId, currentModelId, models} = sessionMetadata;
        const authProvider = sessionMetadata.modelProvider ?? this.codexAcpClient.getModelProvider();
        let authState: ActiveAuthState;
        try {
            authState = await this.getAuthStateForProvider(authProvider);
        } catch (err) {
            if (resumeSubscribed && requestedSessionGeneration !== null) {
                await this.cleanupStaleSessionOpen(sessionId, requestedSessionGeneration);
            }
            throw err;
        }
        const sessionGeneration = requestedSessionGeneration ?? this.beginSessionOpen(sessionId);
        if (!this.sessionOpenCanInstall(sessionId, sessionGeneration)) {
            resumeSubscribed = false;
            await this.closeStaleSessionOpen(sessionId, sessionGeneration);
        }
        const sessionMcpServers = this.resolveSessionMcpServers(requestedMcpServers, operation === "resume");
        const currentModel = this.findCurrentModel(models, currentModelId);
        const currentModelSupportsFast = modelSupportsFast(currentModel);
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            availableModels: models,
            supportedReasoningEfforts: currentModel?.supportedReasoningEfforts ?? [],
            supportedInputModalities: currentModel?.inputModalities ?? ["text", "image"],
            agentMode: AgentMode.getInitialAgentMode(),
            collaborationMode: sessionMetadata.collaborationMode,
            currentTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: authState.account,
            authConfigured: authState.authConfigured,
            authProvider: authProvider,
            cwd: request.cwd,
            additionalDirectories: sessionMetadata.additionalDirectories,
            mcpServers: requestedMcpServers,
            fastModeEnabled: sessionMetadata.currentServiceTier === "fast",
            currentModelSupportsFast: currentModelSupportsFast,
            sessionMcpServers: sessionMcpServers,
            terminalOutputMode: this.terminalOutputMode,
            goalRevision: 0,
            sessionTitle: null,
            sessionTitleSource: operation === "resume" ? "unknown" : "unset",
            subagents: new CodexSubagentEventRouter(
                sessionId,
                clientSupportsSubagents(this.clientCapabilities),
                new ACPSessionConnection(this.connection, sessionId),
            ),
        };
        this.sessions.set(sessionId, sessionState);
        resumeSubscribed = false;

        const canPublishSessionUpdates = operation !== "fork";
        if (canPublishSessionUpdates && requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            this.pendingMcpStartupSessions.set(sessionId, {
                requestedServers: new Set(getRequestedMcpServerNames(requestedMcpServers)),
                afterVersion: mcpServerStartupVersion,
            });
            this.publishMcpStartupStatusAsync(sessionId);
        }

        if (canPublishSessionUpdates) {
            this.publishAvailableCommandsAsync(sessionState, sessionGeneration);
        }
        if (operation === "resume") {
            this.publishCurrentGoalAsync(sessionState, sessionGeneration);
        }
        const sessionModelState: LegacySessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState = sessionState.agentMode.toSessionModeState();

        return [sessionId, sessionModelState, sessionModeState];
    }

    private async getAuthStateForProvider(authProvider: string | null): Promise<ActiveAuthState> {
        if (!this.authProviderUsesOpenAiAccount(authProvider)) {
            return {
                account: null,
                authConfigured: true,
            };
        }
        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        return {
            account: accountResponse.account,
            authConfigured: accountResponse.account !== null || !accountResponse.requiresOpenaiAuth,
        };
    }

    private authProviderUsesOpenAiAccount(authProvider: string | null): boolean {
        return authProvider === null || authProvider === "openai";
    }

    private authProvidersMatch(a: string | null, b: string | null): boolean {
        if (this.authProviderUsesOpenAiAccount(a) && this.authProviderUsesOpenAiAccount(b)) {
            return true;
        }
        return a === b;
    }

    private getAuthProviderForAuthenticateRequest(request: acp.AuthenticateRequest): string | null {
        if (isCodexAuthRequest(request) && request.methodId === "gateway") {
            return "custom-gateway";
        }
        return null;
    }

    async loadSession(params: acp.LoadSessionRequest): Promise<LegacyLoadSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Loading session...", {sessionId: params.sessionId});
        const {
            sessionId,
            modelState,
            modeState,
            thread,
        } = await this.getOrCreateSessionWithHistory(params);

        await this.streamThreadHistory(sessionId, thread);

        logger.log("Session loaded", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<LegacyResumeSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Resuming session...", {sessionId: params.sessionId});
        const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);

        logger.log("Session resumed", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    async forkSession(params: acp.ForkSessionRequest): Promise<acp.ForkSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Forking session...", {sessionId: params.sessionId});
        try {
            const [sessionId, , modeState] = await this.tryCreateSession(params, "fork");
            logger.log("Session forked", {sourceSessionId: params.sessionId, sessionId});
            return {
                sessionId,
                modes: modeState,
                ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
            };
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            await this.handleError(error);
            throw e;
        }
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        logger.log("Listing sessions...", {cwd: params.cwd, cursor: params.cursor});
        await this.checkAuthorization();
        const response = await this.runWithProcessCheck(() => this.codexAcpClient.listSessions(params));
        return {
            ...response,
            sessions: response.sessions.map((session) => {
                const activeSession = this.sessions.get(session.sessionId);
                if (!activeSession || activeSession.additionalDirectories.length === 0) {
                    return session;
                }
                return {
                    ...session,
                    additionalDirectories: activeSession.additionalDirectories,
                };
            }),
        };
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        logger.log("Closing session...", {sessionId: params.sessionId});
        const closeGeneration = this.bumpSessionGeneration(params.sessionId);
        const sessionState = this.sessions.get(params.sessionId);
        this.beginSessionCloseFence(params.sessionId);
        this.abortGuardedTtyExecutions(params.sessionId);

        try {
            if (sessionState) {
                await this.interruptSessionTurn(sessionState, "Close", true);
            } else {
                logger.log("Close request received for unknown local session", {sessionId: params.sessionId});
            }

            const activePrompt = this.activePrompts.get(params.sessionId);
            if (activePrompt) {
                activePrompt.requestClose();
                await activePrompt.completion;
            }

            await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(params.sessionId));
            logger.log("Session closed", {sessionId: params.sessionId});
        } finally {
            if (this.getSessionGeneration(params.sessionId) === closeGeneration) {
                this.sessions.delete(params.sessionId);
                this.pendingMcpStartupSessions.delete(params.sessionId);
                this.pendingTurnStarts.delete(params.sessionId);
                this.activePrompts.delete(params.sessionId);
                this.steeringQueues.delete(params.sessionId);
                this.goalControlGenerations.delete(params.sessionId);
            }
            this.endSessionCloseFence(params.sessionId);
        }

        return {};
    }

    private abortGuardedTtyExecutions(sessionId: string): void {
        const executions = this.guardedTtyExecutions.get(sessionId);
        if (!executions) return;
        for (const execution of executions) {
            execution.abort("stale_session");
        }
    }

    async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        logger.log("Deleting session...", {sessionId: params.sessionId});
        const sessionId = params.sessionId;
        const shouldCloseLocalSession = this.hasLocalSession(sessionId);

        this.beginSessionCloseFence(sessionId);
        try {
            if (shouldCloseLocalSession) {
                await this.closeSession({sessionId});
            } else {
                this.bumpSessionGeneration(sessionId);
            }

            await this.runWithProcessCheck(() => this.codexAcpClient.deleteSession(sessionId));
            logger.log("Session deleted", {sessionId});
        } finally {
            this.endSessionCloseFence(sessionId);
        }

        return {};
    }

    private hasLocalSession(sessionId: string): boolean {
        return this.sessions.has(sessionId)
            || this.pendingMcpStartupSessions.has(sessionId)
            || this.pendingTurnStarts.has(sessionId)
            || this.activePrompts.has(sessionId)
            || this.hasPendingSessionOpen(sessionId)
            || this.sessionIsClosing(sessionId);
    }

    private hasPendingSessionOpen(sessionId: string): boolean {
        return this.sessionOpenGenerations.get(sessionId) === this.getSessionGeneration(sessionId);
    }

    async newSession(
        params: acp.NewSessionRequest,
    ): Promise<LegacyNewSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Starting new session...");
        const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);

        logger.log("New session created", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });

        return {
            sessionId: sessionId,
            models: modelState,
            modes: modeState,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
        requestId?: acp.JsonRpcId,
    ): Promise<acp.AuthenticateResponse> {
        logger.log("Authenticate request received");
        const elicitationRequester = this.createUrlElicitationRequester(requestId);
        const isAuthenticated = await this.runWithProcessCheck(() => this.codexAcpClient.authenticate(_params, elicitationRequester));
        if (!isAuthenticated) {
            logger.log("Authenticate request failed");
            throw RequestError.invalidParams();
        }
        await this.refreshSessionsAuthState(this.getAuthProviderForAuthenticateRequest(_params));
        logger.log("Authenticate request completed");
        return { };
    }

    private createUrlElicitationRequester(requestId?: acp.JsonRpcId): UrlElicitationRequester | undefined {
        if (requestId == null || !clientSupportsUrlElicitation(this.clientCapabilities)) {
            return undefined;
        }
        let elicitationId: string | null = null;
        return {
            elicitUrl: (request) => {
                elicitationId = request.elicitationId;
                return this.connection.request(acp.methods.client.elicitation.create, {
                    mode: "url",
                    requestId,
                    ...request,
                });
            },
            completeElicitation: async () => {
                if (elicitationId === null) {
                    return;
                }
                await this.connection.notify(acp.methods.client.elicitation.complete, {
                    elicitationId,
                });
            },
        };
    }

    async logout(_params: acp.LogoutRequest): Promise<void> {
        logger.log("Logout request received");
        await this.runWithProcessCheck(() => this.codexAcpClient.logout());
        await this.refreshSessionsAuthState(null);
        logger.log("Logout request completed");
    }

    listProviders(_params: acp.ListProvidersRequest): acp.ListProvidersResponse {
        return { providers: this.codexAcpClient.listProviders() };
    }

    async setProvider(params: acp.SetProviderRequest): Promise<acp.SetProviderResponse> {
        this.codexAcpClient.setProvider(params);
        await this.enqueueProviderUpdate((client) => client.setProvider(params));
        return { };
    }

    async disableProvider(params: acp.DisableProviderRequest): Promise<acp.DisableProviderResponse> {
        this.codexAcpClient.disableProvider(params);
        if (params.providerId !== OPENAI_PROVIDER_ID) {
            return { };
        }
        await this.enqueueProviderUpdate((client) => client.disableProvider(params));
        return { };
    }

    private async enqueueProviderUpdate(apply: (client: CodexAcpClient) => void): Promise<void> {
        const previous = this.providerUpdate?.catch(() => undefined) ?? Promise.resolve();
        const update = previous.then(async () => {
            if (this.sessions.size === 0) {
                return;
            }

            const activePrompts = [...this.activePrompts.values()].map(prompt => prompt.completion);
            if (activePrompts.length > 0) {
                logger.log("Waiting for active prompts before provider restart", {count: activePrompts.length});
                await Promise.all(activePrompts);
            }

            logger.log("Restarting Codex app-server for provider update", {sessionCount: this.sessions.size});
            const replacement = await this.restartCodexClient();
            apply(replacement);
            if (this.initializeRequest === null) {
                throw new Error("Cannot restart Codex app-server before ACP initialization");
            }
            await replacement.initialize(this.initializeRequest);
            this.codexAcpClient = replacement;
            this.availableCommands = this.createAvailableCommands(replacement);

            const resumeErrors: unknown[] = [];
            for (const session of this.sessions.values()) {
                try {
                    await replacement.resumeSession({
                        sessionId: session.sessionId,
                        cwd: session.cwd,
                        additionalDirectories: session.additionalDirectories,
                        mcpServers: session.mcpServers ?? [],
                    });
                    session.authProvider = replacement.getModelProvider();
                    logger.log("Resumed session after provider restart", {sessionId: session.sessionId});
                } catch (error) {
                    resumeErrors.push(error);
                    logger.error(`Failed to resume session ${session.sessionId} after provider restart`, error);
                }
            }
            if (resumeErrors.length > 0) {
                throw new AggregateError(resumeErrors, `Failed to resume ${resumeErrors.length} session(s) after provider restart`);
            }
        });
        this.providerUpdate = update;
        try {
            await update;
        } finally {
            if (this.providerUpdate === update) {
                this.providerUpdate = null;
            }
        }
    }

    private captureStderr(): void {
        const state = this.codexProcessState;
        if (state === null || state.stderrProcess === state.connection.process) {
            return;
        }
        state.stderrProcess = state.connection.process;
        state.connection.process.stderr.addListener("data", (data: Buffer) => {
            state.stderr = (state.stderr + data.toString()).slice(-2 * 1024);
        });
    }

    private async restartCodexClient(): Promise<CodexAcpClient> {
        const state = this.codexProcessState;
        if (state === null) {
            throw new Error("Codex process state is unavailable");
        }

        const previous = state.connection;
        const exited = previous.process.exitCode === null
            ? once(previous.process, "exit")
            : Promise.resolve();
        previous.process.stdin.end();
        const forceKill = setTimeout(() => {
            if (previous.process.exitCode === null) {
                logger.log("Codex still running 2s after provider restart; terminating process");
                previous.process.kill();
            }
        }, 2000);
        await exited;
        clearTimeout(forceKill);

        state.stderr = "";
        state.connection = startCodexConnection(state.codexPath);
        this.captureStderr();
        return new CodexAcpClient(
            new CodexAppServerClient(state.connection.connection),
            state.config,
            state.modelProvider,
        );
    }

    private async refreshSessionsAuthState(authProvider: string | null): Promise<void> {
        if (this.sessions.size === 0) return;

        const sessionsToRefresh = [...this.sessions.values()]
            .filter(sessionState => this.authProvidersMatch(sessionState.authProvider, authProvider));
        if (sessionsToRefresh.length === 0) return;

        const authState = await this.getAuthStateForProvider(authProvider);
        for (const sessionState of sessionsToRefresh) {
            sessionState.account = authState.account;
            sessionState.authConfigured = authState.authConfigured;
        }
    }

    async setSessionMode(
        _params: acp.SetSessionModeRequest,
    ): Promise<acp.SetSessionModeResponse> {
        logger.log("Set session mode requested", {
            sessionId: _params.sessionId,
            modeId: _params.modeId
        });
        const sessionState = this.sessions.get(_params.sessionId);
        if (!sessionState) throw new Error(`Session ${_params.sessionId} not found`);

        this.applyModeChange(sessionState, _params.modeId);
        return {};
    }

    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        logger.log("Set session config option requested", {
            sessionId: params.sessionId,
            configId: params.configId,
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        await this.applySessionConfigOption(sessionState, params);

        return {
            configOptions: this.createSessionConfigOptions(sessionState),
        };
    }

    private async applySessionConfigOption(sessionState: SessionState, params: acp.SetSessionConfigOptionRequest): Promise<void> {
        switch (params.configId) {
            case FAST_MODE_CONFIG_ID:
                this.applyFastModeChange(sessionState, params);
                break;
            case MODE_CONFIG_ID:
                this.applyModeChange(sessionState, this.stringConfigValue(params));
                break;
            case COLLABORATION_MODE_CONFIG_ID:
                await this.applyCollaborationModeChange(sessionState, this.stringConfigValue(params));
                break;
            case MODEL_CONFIG_ID:
                this.applyModelChange(sessionState, this.stringConfigValue(params));
                break;
            case REASONING_EFFORT_CONFIG_ID:
                this.applyReasoningEffortChange(sessionState, this.stringConfigValue(params));
                break;
            default:
                throw RequestError.invalidParams();
        }
    }

    private applyFastModeChange(sessionState: SessionState, params: acp.SetSessionConfigOptionRequest): void {
        const value = params.value;
        if (typeof value === "boolean") {
            sessionState.fastModeEnabled = value;
            return;
        }
        if (value !== FAST_MODE_ON && value !== FAST_MODE_OFF) {
            throw RequestError.invalidParams();
        }
        sessionState.fastModeEnabled = value === FAST_MODE_ON;
    }

    private stringConfigValue(params: acp.SetSessionConfigOptionRequest): string {
        if (typeof params.value !== "string") {
            throw RequestError.invalidParams();
        }
        return params.value;
    }

    private applyModeChange(sessionState: SessionState, value: string): void {
        const newMode = AgentMode.find(value);
        if (!newMode) {
            throw RequestError.invalidParams();
        }
        sessionState.agentMode = newMode;
    }

    private async applyCollaborationModeChange(sessionState: SessionState, value: string): Promise<void> {
        const mode = parseCollaborationMode(value);
        if (mode === null) {
            throw RequestError.invalidParams();
        }
        await this.codexAcpClient.setCollaborationMode(sessionState.sessionId, mode, sessionState.currentModelId);
        sessionState.collaborationMode = mode;
    }

    private applyModelChange(sessionState: SessionState, value: string): void {
        const model = sessionState.availableModels.find(m => m.id === value);
        if (!model) {
            const currentModel = ModelId.fromString(sessionState.currentModelId).model;
            if (value === currentModel) {
                return;
            }
            throw RequestError.invalidParams();
        }
        const currentEffort = ModelId.fromString(sessionState.currentModelId).effort;
        const effort = findSupportedEffort(model.supportedReasoningEfforts, currentEffort)
            ?? model.defaultReasoningEffort;
        this.applyModelAndEffort(sessionState, model, effort);
    }

    private applyReasoningEffortChange(sessionState: SessionState, value: string): void {
        const effort = findSupportedEffort(sessionState.supportedReasoningEfforts, value);
        if (!effort) {
            throw RequestError.invalidParams();
        }
        const {model} = ModelId.fromString(sessionState.currentModelId);
        sessionState.currentModelId = ModelId.create(model, effort).toString();
    }

    private applyModelAndEffort(sessionState: SessionState, model: Model, effort: ReasoningEffort): void {
        sessionState.currentModelId = ModelId.fromComponents(model, effort).toString();
        sessionState.supportedReasoningEfforts = model.supportedReasoningEfforts;
        sessionState.supportedInputModalities = model.inputModalities;
        sessionState.currentModelSupportsFast = modelSupportsFast(model);
    }

    async unstable_setSessionModel(params: LegacySetSessionModelRequest): Promise<LegacySetSessionModelResponse> {
        logger.log("Set session model requested", {
            sessionId: params.sessionId,
            modelId: params.modelId
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        const {model: requestedModelName, effort: requestedEffort} = ModelId.fromString(params.modelId);

        const models = await this.codexAcpClient.fetchAvailableModels();
        const model = models.find(m => m.id === requestedModelName);
        if (!model) throw new Error(`Unknown model ${params.modelId}`);

        let reasoningEffort: ReasoningEffort;
        if (requestedEffort) {
            const matchedEffort = findSupportedEffort(model.supportedReasoningEfforts, requestedEffort);
            if (!matchedEffort) {
                throw new Error(`Unsupported reasoning effort ${requestedEffort} for model ${requestedModelName}`);
            }
            reasoningEffort = matchedEffort;
        } else {
            reasoningEffort = model.defaultReasoningEffort;
        }

        sessionState.availableModels = models;
        this.applyModelAndEffort(sessionState, model, reasoningEffort);

        return {};
    }

    private guardedTtyCapability(
        params: KandevGuardedTtyCapabilityRequest,
    ): KandevGuardedTtyCapabilityResponse {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState || !this.sessionPublishIsCurrent(
            sessionState,
            this.getSessionGeneration(params.sessionId),
        )) {
            throw RequestError.invalidParams(undefined, "Unknown or stale session");
        }
        return {
            capability: KANDEV_GUARDED_TTY_CAPABILITY,
            version: KANDEV_GUARDED_TTY_VERSION,
            supported: true,
            capability_method: KANDEV_GUARDED_TTY_CAPABILITY_METHOD,
            exec_method: KANDEV_GUARDED_TTY_EXEC_METHOD,
            session_id: sessionState.sessionId,
        };
    }

    private async executeGuardedTtyExec(
        params: KandevGuardedTtyExecRequest,
        requestSignal?: AbortSignal,
    ): Promise<KandevGuardedTtyExecReceipt> {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState || this.sessionIsClosing(params.sessionId)) {
            return createUndispatchedGuardedTtyReceipt(params.sessionId, "stale_session");
        }
        const sessionGeneration = this.getSessionGeneration(params.sessionId);
        const controller = new AbortController();
        const abortFromRequest = () => controller.abort("cancelled");
        if (requestSignal?.aborted) {
            abortFromRequest();
        } else {
            requestSignal?.addEventListener("abort", abortFromRequest, {once: true});
        }
        const executions = this.guardedTtyExecutions.get(params.sessionId) ?? new Set<AbortController>();
        executions.add(controller);
        this.guardedTtyExecutions.set(params.sessionId, executions);

        try {
            return await this.codexAcpClient.guardedTtyExec({
                sessionId: sessionState.sessionId,
                argv: params.argv,
                cwd: sessionState.cwd,
                sandboxPolicy: sessionState.agentMode.sandboxPolicy,
                signal: controller.signal,
                isSessionCurrent: () => this.sessionPublishIsCurrent(sessionState, sessionGeneration),
            });
        } finally {
            requestSignal?.removeEventListener("abort", abortFromRequest);
            executions.delete(controller);
            if (executions.size === 0) {
                this.guardedTtyExecutions.delete(params.sessionId);
            }
        }
    }

    private parseGuardedTtyCapabilityParams(
        params: Record<string, unknown>,
    ): KandevGuardedTtyCapabilityRequest {
        if (!hasExactKeys(params, ["sessionId"]) || typeof params["sessionId"] !== "string") {
            throw RequestError.invalidParams();
        }
        return {sessionId: params["sessionId"]};
    }

    private parseGuardedTtyExecParams(params: Record<string, unknown>): KandevGuardedTtyExecRequest {
        const sessionId = params["sessionId"];
        const argv = params["argv"];
        if (!hasExactKeys(params, ["argv", "sessionId"])
            || typeof sessionId !== "string"
            || !Array.isArray(argv)
            || !argv.every((arg): arg is string => typeof arg === "string")
            || !validateGuardedTtyArgv(argv)) {
            throw RequestError.invalidParams();
        }
        return {sessionId, argv};
    }

    private parseLegacySetSessionModelParams(params: Record<string, unknown>): LegacySetSessionModelRequest {
        const sessionId = params["sessionId"];
        const modelId = params["modelId"];
        if (typeof sessionId !== "string" || typeof modelId !== "string") {
            throw RequestError.invalidParams();
        }
        return {
            sessionId: sessionId,
            modelId: modelId,
        };
    }

    /**
     * Handles one incoming steering request, serialising it against any other
     * steer already in flight for the same session.
     *
     * Every session gets its own {@link SteeringQueue}: the request is enqueued
     * and awaited, so concurrent steers for one session run strictly one at a
     * time, in arrival order, and can never race to inject into — or start —
     * rival turns. Steers for different sessions use different queues and run
     * concurrently. Once the queue drains to idle it is removed from the map,
     * so no per-session entry leaks after the session goes quiet (the identity
     * check guards against deleting a queue a later request has since reused).
     *
     * @param params The target session id and the prompt to steer with.
     * @returns Whether the prompt joined the active turn ("injected"), started a
     *     new one ("startedNewTurn"), or could not be applied ("failed"); see
     *     {@link performSteeringRequest}.
     */
    async executeOrQueueSteeringRequest(params: SessionSteerRequest): Promise<SessionSteeringResponse> {
        const queue = this.getSteeringQueue(params.sessionId);
        try {
            return await queue.enqueue(params);
        } catch (error) {
            if (error instanceof RequestError) {
                throw error;
            }
            logger.error(`Steering request for session ${params.sessionId} failed`, error);
            return {outcome: "failed"};
        } finally {
            if (queue.isIdle && this.steeringQueues.get(params.sessionId) === queue) {
                this.steeringQueues.delete(params.sessionId);
            }
        }
    }

    /**
     * Returns the steering queue for a session, creating and registering it on
     * first use.
     *
     * @param sessionId The session whose steering queue is required.
     * @returns The session's existing queue, or a freshly created one.
     */
    private getSteeringQueue(sessionId: string): SteeringQueue {
        let queue = this.steeringQueues.get(sessionId);
        if (!queue) {
            queue = new SteeringQueue((params) => this.performSteeringRequest(params));
            this.steeringQueues.set(sessionId, queue);
        }
        return queue;
    }

    /**
     * Delivers a steering prompt to the session: injects it into the live turn
     * when there is one, otherwise starts a new turn.
     *
     * @param params The target session id and the prompt to steer with.
     * @returns "injected" when the prompt joined an existing turn, otherwise the
     *     outcome of starting a new turn.
     */
    private async performSteeringRequest(params: SessionSteerRequest): Promise<SessionSteeringResponse> {
        logger.log("Steering session requested", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        this.assertSteerInputSupported(params, sessionState);

        const turnId = await this.getSteerableTurnId(sessionState);
        if (turnId) {
            const injected = await this.injectSteerIntoActiveTurn(params, turnId, sessionState);
            if (injected) {
                logger.log("Steering session injected", {sessionId: params.sessionId, turnId});
                return {outcome: "injected"};
            }
        }
        return await this.startNewTurnFromSteering(params);
    }

    /**
     * Rejects a steering prompt whose content the active model cannot accept
     * (currently: image blocks on a text-only model).
     */
    private assertSteerInputSupported(params: SessionSteerRequest, sessionState: SessionState): void {
        const hasImage = params.prompt.some(block => block.type === "image");
        if (hasImage && !sessionState.supportedInputModalities.includes("image")) {
            throw RequestError.invalidRequest("The current model does not support image input");
        }
    }

    /**
     * Attempts to inject the prompt into the given running turn.
     *
     * A failed injection is fatal only when the turn is still the session's
     * current turn and Codex reported something other than "no active turn to
     * steer". Otherwise the turn has already ended underneath us and the caller
     * should start a new turn instead.
     *
     * @returns true when the prompt was injected; false when the caller should
     *     fall back to starting a new turn.
     */
    private async injectSteerIntoActiveTurn(
        params: SessionSteerRequest,
        turnId: string,
        sessionState: SessionState,
    ): Promise<boolean> {
        try {
            await this.runWithProcessCheck(() => this.codexAcpClient.steerTurn({
                threadId: params.sessionId,
                turnId,
                prompt: params.prompt,
            }));
            return true;
        } catch (err) {
            await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            const turnStillActive = sessionState.currentTurnId === turnId;
            if (turnStillActive && !this.isNoActiveTurnToSteerError(err)) {
                throw err;
            }
            return false;
        }
    }

    /**
     * Starts a new turn from a steering prompt when there is no live turn to
     * inject into, and returns as soon as that turn is running.
     *
     * Waits for any previous prompt to drain first, then re-checks that the
     * session is not closing — the await above is a window during which a close
     * request can arrive.
     *
     * @param params The target session id and the prompt to steer with.
     * @returns "startedNewTurn" once the turn is running; throws if the prompt
     *     fails or is cancelled before the turn starts.
     */
    private async startNewTurnFromSteering(params: SessionSteerRequest): Promise<SessionSteeringResponse> {
        await this.startNewTurnFromExternalPrompt(params, "Steering");
        return {outcome: "startedNewTurn"};
    }

    private async startGoalContinuationIfCurrent(
        sessionState: SessionState,
        sessionGeneration: number,
        goalControlGeneration: number,
        expectedGoal: ThreadGoal,
    ): Promise<void> {
        await this.startNewTurnFromExternalPrompt({
            sessionId: sessionState.sessionId,
            prompt: GOAL_CONTINUATION_PROMPT,
        }, "Goal continuation", async () => {
            if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)
                || this.goalControlGenerations.get(sessionState.sessionId) !== goalControlGeneration) {
                return false;
            }
            const currentGoal = await this.runWithProcessCheck(() => this.codexAcpClient.getGoal(sessionState.sessionId));
            return currentGoal?.status === "active"
                && currentGoal.objective === expectedGoal.objective
                && currentGoal.createdAt === expectedGoal.createdAt
                && this.goalControlGenerations.get(sessionState.sessionId) === goalControlGeneration;
        });
    }

    private async startNewTurnFromExternalPrompt(
        params: acp.PromptRequest,
        source: string,
        canStart: () => Promise<boolean> = async () => true,
    ): Promise<boolean> {
        // A prompt can outlive its turn while post-turn cleanup runs. Starting a
        // control-triggered turn during that window would run two prompts on the
        // same session, so wait for the current prompt to drain first.
        const previousPrompt = this.activePrompts.get(params.sessionId);
        await previousPrompt?.completion;
        if (this.sessionIsClosing(params.sessionId)) {
            throw RequestError.invalidRequest(`Session ${params.sessionId} is closing`);
        }
        if (!await canStart()) {
            return false;
        }

        return await new Promise<boolean>((resolve, reject) => {
            let turnStarted = false;
            const promptDone = this.prompt(params, undefined, () => {
                turnStarted = true;
                logger.log(`${source} started a new turn`, {sessionId: params.sessionId});
                // The new turn is now running. This is the success path: answer the
                // steer immediately ("a turn was started") and let prompt() finish the
                // turn in the background.
                resolve(true);
            });
            promptDone.then(
                (response) => {
                    if (!turnStarted && response.stopReason === "cancelled") {
                        // The prompt ended without the turn ever starting, because it
                        // was cancelled. The steer never took, so fail the request.
                        reject(RequestError.invalidRequest(`Session ${params.sessionId} was cancelled before the steering turn started`));
                    } else {
                        // Either the turn already started (this is a no-op after the
                        // resolve in the callback above), or the prompt finished
                        // without ever starting a turn and was not cancelled (e.g. a
                        // command-only turn). Both count as a successfully accepted steer.
                        resolve(turnStarted);
                    }
                },
                (error: unknown) => {
                    if (turnStarted) {
                        // The turn had already started, so the steer was already
                        // answered "startedNewTurn". This is a failure of a turn running
                        // in the background — nothing to return, just log it.
                        logger.error(`${source} prompt for session ${params.sessionId} failed`, error);
                    } else {
                        // The prompt failed before the turn started. The steer never
                        // took, so surface the failure to the caller.
                        reject(error);
                    }
                },
            );
        });
    }

    private isNoActiveTurnToSteerError(error: unknown): boolean {
        const messages = error instanceof Error ? [error.message] : [];
        if (typeof error === "object" && error !== null && "data" in error) {
            const data = (error as {data?: unknown}).data;
            if (typeof data === "string") {
                messages.push(data);
            } else if (typeof data === "object" && data !== null && "details" in data) {
                const details = (data as {details?: unknown}).details;
                if (typeof details === "string") {
                    messages.push(details);
                }
            }
        }
        return messages.some(message => message.toLowerCase().includes("no active turn to steer"));
    }

    private async getSteerableTurnId(sessionState: SessionState): Promise<string | null> {
        if (this.sessionIsClosing(sessionState.sessionId)) {
            return null;
        }
        if (sessionState.currentTurnId) {
            return sessionState.currentTurnId;
        }

        const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
        if (!pendingTurnStart) {
            return null;
        }
        return await pendingTurnStart.promise;
    }

    private parseSessionSteerParams(params: Record<string, unknown>): SessionSteerRequest {
        const sessionId = params["sessionId"];
        const prompt = params["prompt"];
        if (typeof sessionId !== "string" || !Array.isArray(prompt)) {
            throw RequestError.invalidParams();
        }
        return {
            sessionId: sessionId,
            prompt: prompt as acp.ContentBlock[],
        };
    }

    private createSessionConfigOptions(sessionState: SessionState): Array<acp.SessionConfigOption> {
        const currentModelId = ModelId.fromString(sessionState.currentModelId);
        const configOptions = [
            sessionState.agentMode.toConfigOption(),
            createCollaborationModeConfigOption(sessionState.collaborationMode),
            createModelConfigOption(sessionState.availableModels, currentModelId.model),
        ];
        if (sessionState.supportedReasoningEfforts.length > 0) {
            configOptions.push(
                createReasoningEffortConfigOption(sessionState.supportedReasoningEfforts, currentModelId.effort),
            );
        }
      if (sessionState.currentModelSupportsFast) {
        configOptions.push(createFastModeConfigOption(
          sessionState.fastModeEnabled,
          this.booleanConfigOptionsSupported,
        ));
      }
        return configOptions;
    }

    private createSessionConfigOptionsResponse(sessionState: SessionState): {
        configOptions?: Array<acp.SessionConfigOption>;
    } {
        if (!this.isSessionConfigEnabled()) {
            return {};
        }
        return {
            configOptions: this.createSessionConfigOptions(sessionState),
        };
    }

    private isSessionConfigEnabled(): boolean {
        // Temporarily disabled for JB IDEs 2026.1 due to issues in session_config (LLM-28118)
        return !isJetBrains2026_1Client(this.clientInfo);
    }

    private publishAvailableCommandsAsync(sessionState: SessionState, sessionGeneration: number): void {
        void this.publishAvailableCommands(sessionState, sessionGeneration);
    }

    private async publishAvailableCommands(sessionState: SessionState, sessionGeneration: number): Promise<void> {
        await this.availableCommands.publish(
            sessionState,
            () => this.sessionPublishIsCurrent(sessionState, sessionGeneration),
        );
    }

    private publishCurrentGoalAsync(sessionState: SessionState, sessionGeneration: number): void {
        void this.publishCurrentGoalBestEffort(sessionState, sessionGeneration, true);
    }

    private async publishCurrentGoalBestEffort(
        sessionState: SessionState,
        sessionGeneration: number,
        force: boolean,
    ): Promise<void> {
        try {
            await this.publishCurrentGoal(sessionState, sessionGeneration, force);
        } catch (err) {
            logger.error(`Failed to publish current goal for session ${sessionState.sessionId}`, err);
        }
    }

    private async publishCurrentGoal(
        sessionState: SessionState,
        sessionGeneration: number,
        force: boolean,
    ): Promise<void> {
        const requestRevision = ++sessionState.goalRevision;
        const goal = await this.runWithProcessCheck(() => this.codexAcpClient.getGoal(sessionState.sessionId));
        const snapshot = goal === null ? null : toThreadGoalSnapshot(goal);
        if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)
            || sessionState.goalRevision !== requestRevision) {
            return;
        }
        await this.publishGoalSnapshot(sessionState, snapshot, force, false);
    }

    private sessionPublishIsCurrent(sessionState: SessionState, sessionGeneration: number): boolean {
        return this.sessions.get(sessionState.sessionId) === sessionState
            && this.getSessionGeneration(sessionState.sessionId) === sessionGeneration
            && !this.sessionIsClosing(sessionState.sessionId);
    }

    private async publishGoalSnapshot(
        sessionState: SessionState,
        snapshot: ThreadGoalSnapshot | null,
        force: boolean,
        incrementRevision = true,
    ): Promise<void> {
        if (incrementRevision) {
            sessionState.goalRevision += 1;
        }
        if (!force && sameThreadGoalSnapshot(sessionState.currentGoal, snapshot)) {
            return;
        }
        sessionState.currentGoal = snapshot;
        const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
        await session.update({
            sessionUpdate: "session_info_update",
            _meta: {
                goal: snapshot,
            },
        });
    }

    private findCurrentModel(models: Model[], currentModelId: string): Model | undefined {
        const modelId = ModelId.fromString(currentModelId);
        return models.find(m => m.id === modelId.model);
    }

    private normalizeModelDisplayName(displayName: string): string {
        return displayName
            .split("-")
            .map((token) => CodexAcpServer.MODEL_NAME_TOKEN_OVERRIDES[token.toLowerCase()] ?? token)
            .join("-");
    }

    private createModelState(availableModels: Model[], selectedModelId: string): LegacySessionModelState {
        const allowedModels = availableModels
            .flatMap((model) =>
                model.supportedReasoningEfforts.map((effort) => ({
                    modelId: ModelId.fromComponents(model, effort.reasoningEffort).toString(),
                    name: `${this.normalizeModelDisplayName(model.displayName)} (${effort.reasoningEffort})`,
                    description: `${model.description} ${effort.description}`,
                }))
            );
        return {
            availableModels: allowedModels,
            currentModelId: selectedModelId,
        }
    }

    private async getOrCreateSessionWithHistory(
        request: acp.LoadSessionRequest
    ): Promise<{
        sessionId: SessionId;
        modelState: LegacySessionModelState;
        modeState: SessionModeState;
        thread: Thread;
    }> {
        const requestedSessionGeneration = this.beginSessionOpen(request.sessionId);
        await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const mcpServerStartupVersion = requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;

        logger.log(`Load existing session: ${request.sessionId}...`);
        let subscribed = false;
        let sessionMetadata: SessionMetadataWithThread;
        try {
            sessionMetadata = await this.runWithProcessCheck(() =>
                this.codexAcpClient.loadSession(request, () => {
                    subscribed = true;
                })
            );
        } catch (err) {
            if (subscribed) {
                await this.cleanupStaleSessionOpen(request.sessionId, requestedSessionGeneration);
            }
            throw err;
        }

        const {sessionId, currentModelId, models, thread} = sessionMetadata;
        const authProvider = sessionMetadata.modelProvider ?? this.codexAcpClient.getModelProvider();
        let authState: ActiveAuthState;
        try {
            authState = await this.getAuthStateForProvider(authProvider);
        } catch (err) {
            if (subscribed) {
                await this.cleanupStaleSessionOpen(request.sessionId, requestedSessionGeneration);
            }
            throw err;
        }
        if (!this.sessionOpenCanInstall(sessionId, requestedSessionGeneration)) {
            subscribed = false;
            await this.closeStaleSessionOpen(sessionId, requestedSessionGeneration);
        }
        const sessionMcpServers = this.resolveSessionMcpServers(requestedMcpServers, true);
        const currentModel = this.findCurrentModel(models, currentModelId);
        const currentModelSupportsFast = modelSupportsFast(currentModel);
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            availableModels: models,
            supportedReasoningEfforts: currentModel?.supportedReasoningEfforts ?? [],
            supportedInputModalities: currentModel?.inputModalities ?? ["text", "image"],
            agentMode: AgentMode.getInitialAgentMode(),
            collaborationMode: sessionMetadata.collaborationMode,
            currentTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: authState.account,
            authConfigured: authState.authConfigured,
            authProvider: authProvider,
            cwd: request.cwd,
            additionalDirectories: sessionMetadata.additionalDirectories,
            mcpServers: requestedMcpServers,
            fastModeEnabled: sessionMetadata.currentServiceTier === "fast",
            currentModelSupportsFast: currentModelSupportsFast,
            sessionMcpServers: sessionMcpServers,
            terminalOutputMode: this.terminalOutputMode,
            goalRevision: 0,
            sessionTitle: null,
            sessionTitleSource: "unset",
            subagents: new CodexSubagentEventRouter(
                sessionId,
                clientSupportsSubagents(this.clientCapabilities),
                new ACPSessionConnection(this.connection, sessionId),
            ),
        };
        this.sessions.set(sessionId, sessionState);
        subscribed = false;

        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            this.pendingMcpStartupSessions.set(sessionId, {
                requestedServers: new Set(getRequestedMcpServerNames(requestedMcpServers)),
                afterVersion: mcpServerStartupVersion,
            });
            this.publishMcpStartupStatusAsync(sessionId);
        }

        await this.publishAvailableCommands(sessionState, requestedSessionGeneration);
        await this.publishCurrentGoalBestEffort(sessionState, requestedSessionGeneration, true);
        const sessionModelState: LegacySessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState = sessionState.agentMode.toSessionModeState();

        return {
            sessionId: sessionId,
            modelState: sessionModelState,
            modeState: sessionModeState,
            thread: thread,
        };
    }

    private async streamThreadHistory(sessionId: string, thread: Thread): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        const sessionState = this.getSessionState(sessionId);
        await this.publishThreadHistoryTitle(session, sessionState, thread);
        if (clientSupportsSubagents(this.clientCapabilities)) {
            await this.streamNativeThreadHistory(
                sessionId,
                thread,
                sessionState,
                new Set([sessionId]),
                new Map([[sessionId, thread]]),
            );
            return;
        }
        const responseItemFallbackUpdates = await createResponseItemHistoryFallbackUpdates(
            thread,
            sessionState.terminalOutputMode,
        );

        const threadUpdates: UpdateSessionEvent[] = [];
        for (const turn of thread.turns) {
            for (const item of turn.items) {
                const updates = await this.createHistoryUpdates(item, sessionState);
                threadUpdates.push(...updates);
            }
        }

        const updates = responseItemFallbackUpdates
            ? mergeHistoryUpdates(responseItemFallbackUpdates, threadUpdates)
            : threadUpdates;
        for (const update of updates) {
            await session.update(update);
        }
    }

    private async streamNativeThreadHistory(
        sessionId: string,
        thread: Thread,
        sessionState: SessionState,
        ancestry: Set<string>,
        threadCache: Map<string, Thread | null>,
    ): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        const announced = new Map<string, {generation: number; sessionId: string; terminal: boolean}>();
        for (const turn of thread.turns) {
            for (const item of turn.items) {
                if (item.type === "subAgentActivity") {
                    const activityKind = item.kind as string;
                    if (activityKind === "started") {
                        const previous = announced.get(item.agentThreadId);
                        if (previous && !previous.terminal) continue;
                        const generation = (previous?.generation ?? 0) + 1;
                        const childSessionId = generation === 1
                            ? item.agentThreadId
                            : `${item.agentThreadId}:generation:${generation}`;
                        const name = nameFromAgentPath(item.agentPath, `Agent ${item.agentThreadId.slice(-8)}`);
                        await session.update({
                            sessionUpdate: "subagent_spawned",
                            subagentSessionId: childSessionId,
                            name,
                            task: `Delegated task for ${name}`,
                            capabilities: {},
                        });
                        announced.set(item.agentThreadId, {generation, sessionId: childSessionId, terminal: false});
                        if (!ancestry.has(item.agentThreadId)) {
                            let child = threadCache.get(item.agentThreadId);
                            if (child === undefined) {
                                try {
                                    child = await this.codexAcpClient.readSessionThread(item.agentThreadId);
                                    threadCache.set(item.agentThreadId, child);
                                }
                                catch (error) {
                                    threadCache.set(item.agentThreadId, null);
                                    logger.error(`Failed to read subagent history ${item.agentThreadId}`, error);
                                    child = null;
                                }
                            }
                            const childTurn = child?.turns[generation - 1];
                            if (child && childTurn) {
                                await this.streamNativeThreadHistory(
                                    childSessionId,
                                    {...child, turns: [childTurn]},
                                    sessionState,
                                    new Set([...ancestry, item.agentThreadId]),
                                    threadCache,
                                );
                            }
                        }
                    }
                    else if (activityKind === "completed" || activityKind === "interrupted") {
                        const child = announced.get(item.agentThreadId);
                        if (!child) {
                            const name = nameFromAgentPath(item.agentPath, `Agent ${item.agentThreadId.slice(-8)}`);
                            await session.update({
                                sessionUpdate: "subagent_spawned",
                                subagentSessionId: item.agentThreadId,
                                name,
                                task: `Delegated task for ${name}`,
                                capabilities: {},
                            });
                            announced.set(item.agentThreadId, {
                                generation: 1,
                                sessionId: item.agentThreadId,
                                terminal: false,
                            });
                            continue;
                        }
                        if (child.terminal) continue;
                        await session.update({
                            sessionUpdate: "subagent_state_update",
                            subagentSessionId: child.sessionId,
                            state: activityKind === "completed" ? "completed" : "cancelled",
                        });
                        child.terminal = true;
                    }
                    continue;
                }
                if (item.type === "collabAgentToolCall") continue;
                for (const update of await this.createHistoryUpdates(item, sessionState)) {
                    await session.update(update);
                }
            }
        }
        for (const child of announced.values()) {
            if (child.terminal) continue;
            await session.update({
                sessionUpdate: "subagent_state_update",
                subagentSessionId: child.sessionId,
                state: "disconnected",
            });
        }
    }

    private async publishThreadHistoryTitle(
        session: ACPSessionConnection,
        sessionState: SessionState,
        thread: Thread,
    ): Promise<void> {
        const explicitTitle = this.normalizeSessionTitle(thread.name);
        if (explicitTitle) {
            sessionState.sessionTitle = explicitTitle;
            sessionState.sessionTitleSource = "explicit";
            await session.update({
                sessionUpdate: "session_info_update",
                title: explicitTitle,
            });
            return;
        }

        const historyTitle = this.findFirstUserMessageTitle(thread)
            ?? this.normalizeSessionTitle(thread.preview);
        await this.publishFallbackSessionTitle(sessionState, historyTitle);
    }

    private findFirstUserMessageTitle(thread: Thread): string | null {
        for (const turn of thread.turns) {
            for (const item of turn.items) {
                if (item.type !== "userMessage") continue;
                const title = this.normalizeSessionTitle(item.content
                    .filter((input): input is Extract<UserInput, {type: "text"}> => input.type === "text")
                    .map(input => input.text)
                    .join(" "));
                if (title) return title;
            }
        }
        return null;
    }

    private async publishFallbackSessionTitle(
        sessionState: SessionState,
        title: string | null,
    ): Promise<void> {
        if (sessionState.sessionTitleSource !== "unset" || !title) return;
        sessionState.sessionTitle = title;
        sessionState.sessionTitleSource = "fallback";
        const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
        await session.update({
            sessionUpdate: "session_info_update",
            title,
        });
    }

    private async publishAgentFileChangeReport(
        sessionState: SessionState,
        turnId: string | null,
        request: AgentFileChangeReportRequest,
        unavailableReason: AgentFileChangeReportUnavailableReason,
        signal: AbortSignal,
    ): Promise<void> {
        let report: AgentFileChangeReport;
        try {
            report = turnId === null
                ? createUnavailableAgentFileChangeReport(request.requestId, unavailableReason)
                : await this.codexAcpClient.runAgentFileChangeReport({
                    sessionId: sessionState.sessionId,
                    turnId,
                    // The client owns request-id correlation and duplicate suppression. The wrapper
                    // stays stateless so a retried ACP prompt still receives a terminal report.
                    requestId: request.requestId,
                    workspace: {
                        cwd: sessionState.cwd,
                        additionalDirectories: sessionState.additionalDirectories,
                    },
                    signal,
                });
        } catch (error) {
            logger.error("Agent file-change report failed unexpectedly", error);
            report = createUnavailableAgentFileChangeReport(request.requestId, "providerError");
        }
        try {
            const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
            await session.update({
                sessionUpdate: "session_info_update",
                _meta: {
                    [JETBRAINS_META_KEY]: {
                        [AIR_META_KEY]: {
                            [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                            [AIR_AGENT_FILE_CHANGE_REPORT_KEY]: report,
                        },
                    },
                },
            });
        } catch (error) {
            logger.error("Failed to publish agent file-change report", error);
        }
    }

    private createPromptFallbackTitle(prompt: acp.ContentBlock[]): string | null {
        return this.normalizeSessionTitle(prompt
            .filter((block): block is Extract<acp.ContentBlock, {type: "text"}> => block.type === "text")
            .map(block => block.text)
            .join(" "));
    }

    private normalizeSessionTitle(title: string | null | undefined): string | null {
        const normalized = title?.replace(/\s+/g, " ").trim() ?? "";
        return normalized.length > 0 ? normalized : null;
    }

    private async createHistoryUpdates(item: ThreadItem, sessionState: SessionState): Promise<UpdateSessionEvent[]> {
        switch (item.type) {
            case "userMessage":
                return this.createUserMessageUpdates(item);
            case "hookPrompt":
            case "sleep":
                return [];
            case "subAgentActivity":
                return [createSubAgentActivityUpdate(item, "completed", "tool_call")];
            case "agentMessage": {
                const meta = createCodexMessagePhaseMeta(item.phase);
                return [{
                    sessionUpdate: "agent_message_chunk",
                    messageId: item.id,
                    content: { type: "text", text: item.text },
                    ...(meta ? { _meta: meta } : {}),
                }];
            }
            case "reasoning":
                return this.createReasoningUpdates(item);
            case "fileChange":
                return [await createFileChangeUpdate(item)];
            case "commandExecution": {
                const updates = [await createCommandExecutionUpdate(item)];
                const completeUpdate = createCommandExecutionCompleteUpdate(item, sessionState.terminalOutputMode);
                if (completeUpdate) {
                    updates.push(completeUpdate);
                }
                return updates;
            }
            case "mcpToolCall":
                return [await createMcpToolCallUpdate(item)];
            case "dynamicToolCall":
                return [await createDynamicToolCallUpdate(item)];
            case "collabAgentToolCall":
                return [createCollabAgentToolCallUpdate(item)];
            case "webSearch":
                return [this.createWebSearchUpdate(item)];
            case "imageView":
                return [createImageViewUpdate(item)];
            case "imageGeneration":
                return [createImageGenerationUpdate(item)];
            case "enteredReviewMode":
                return [this.createReviewModeUpdate(item, true)];
            case "exitedReviewMode":
                return [this.createReviewModeUpdate(item, false)];
            case "contextCompaction":
                return [createCompletedContextCompactionUpdate(item)];
            case "plan":
                return item.text.length > 0 ? [this.createPlanHistoryUpdate(item)] : [];
        }
    }

    private createUserMessageUpdates(item: ThreadItem & { type: "userMessage" }): UpdateSessionEvent[] {
        const updates: UpdateSessionEvent[] = [];
        const messageId = item.id;
        for (const input of item.content) {
            const blocks = this.userInputToContentBlocks(input);
            for (const block of blocks) {
                updates.push(createUserMessageChunk(block, messageId));
            }
        }
        return updates;
    }

    private createReasoningUpdates(item: ThreadItem & { type: "reasoning" }): UpdateSessionEvent[] {
        const parts = item.summary.length > 0 ? item.summary : item.content;
        const messageId = item.id;
        return parts.map((text) => createAgentTextThoughtChunk(text, messageId));
    }

    private createWebSearchUpdate(
        item: ThreadItem & { type: "webSearch" }
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            kind: "search",
            title: formatWebSearchTitle(item),
            status: "completed",
            rawInput: {
                query: item.query,
                action: item.action,
            },
        };
    }

    private createReviewModeUpdate(
        item: ThreadItem & { type: "enteredReviewMode" | "exitedReviewMode" },
        entered: boolean
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `${entered ? "Entered" : "Exited"} review mode: ${item.review}`,
            },
        };
    }

    private createPlanHistoryUpdate(
        item: ThreadItem & { type: "plan" }
    ): UpdateSessionEvent {
        if (clientSupportsPlanUpdates(this.clientCapabilities)) {
            return {
                sessionUpdate: "plan_update",
                plan: {
                    type: "markdown",
                    planId: item.id,
                    content: item.text,
                },
            };
        }
        return createAgentTextMessageChunk(
            item.text,
            item.id,
            createCodexMessagePhaseMeta("final_answer"),
        );
    }

    private userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
        switch (input.type) {
            case "text":
                return input.text.length > 0 ? [{ type: "text", text: input.text }] : [];
            case "image":
                return [{ type: "text", text: this.formatUriAsLink("image", input.url) }];
            case "localImage": {
                const uri = input.path.startsWith("file://") ? input.path : `file://${input.path}`;
                return [{ type: "text", text: this.formatUriAsLink(null, uri) }];
            }
            case "skill":
                return [{ type: "text", text: `skill:${input.name} (${input.path})` }];
        }
        return [];
    }

    private formatUriAsLink(name: string | null, uri: string): string {
        if (name && name.length > 0) {
            return `[@${name}](${uri})`;
        }
        if (uri.startsWith("file://")) {
            const path = uri.replace("file://", "");
            const fileName = path.split("/").pop() ?? path;
            return `[@${fileName}](${uri})`;
        }
        return uri;
    }

    getSessionState(sessionId: string): SessionState {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) {
            throw new Error(`Session ${sessionId} not found`);
        }
        return sessionState;
    }

    private permissionLifecycleContext(sessionState: SessionState): PermissionLifecycleContext {
        const existing = this.permissionLifecycleContexts.get(sessionState);
        if (existing) return existing;
        const context = new PermissionLifecycleContext(sessionState);
        this.permissionLifecycleContexts.set(sessionState, context);
        return context;
    }

    private resolveSessionMcpServers(
        mcpServers: Array<acp.McpServer>,
        recoverFromStartup: boolean,
    ): Array<string> {
        // Explicit MCP servers from the request are the primary source of truth for the session.
        const requestedServerNames = getRequestedMcpServerNames(mcpServers);
        if (requestedServerNames.length > 0) {
            return requestedServerNames;
        }
        // Fresh sessions without MCP config should not inherit any session MCP state.
        if (!recoverFromStartup) {
            return [];
        }
        // Without a thread-scoped startup completion event, loadSession/resumeSession can no longer
        // recover omitted session MCP server names. Treat the session set as unknown unless ACP
        // explicitly provided mcpServers in the request.
        logger.log("Skipping MCP server recovery for load/resume without explicit mcpServers");
        return [];
    }

    private publishMcpStartupStatusAsync(sessionId: string): void {
        void this.doPublishMcpStartupStatus(sessionId);
    }

    private async doPublishMcpStartupStatus(sessionId: string): Promise<void> {
        const pendingStartup = this.pendingMcpStartupSessions.get(sessionId);
        if (!pendingStartup) {
            return;
        }

        try {
            const mcpStartup = await this.runWithProcessCheck(() =>
                this.codexAcpClient.awaitMcpServerStartup(
                    Array.from(pendingStartup.requestedServers),
                    pendingStartup.afterVersion,
                )
            );
            if (!this.sessions.has(sessionId)
                || this.sessionIsClosing(sessionId)
                || this.pendingMcpStartupSessions.get(sessionId) !== pendingStartup) {
                return;
            }
            await this.publishMcpStartupStatus(sessionId, mcpStartup, pendingStartup.requestedServers);
        } catch (err) {
            logger.error(`Failed to publish MCP startup status for session ${sessionId}`, err);
        } finally {
            if (this.pendingMcpStartupSessions.get(sessionId) === pendingStartup) {
                this.pendingMcpStartupSessions.delete(sessionId);
            }
        }
    }

    private async publishMcpStartupStatus(
        sessionId: string,
        mcpStartup: McpStartupResult,
        requestedServers?: Set<string>
    ): Promise<void> {
        const filteredStartup = requestedServers
            ? {
                ready: mcpStartup.ready.filter(server => requestedServers.has(server)),
                failed: mcpStartup.failed.filter(server => requestedServers.has(server.server)),
                cancelled: mcpStartup.cancelled.filter(server => requestedServers.has(server)),
            }
            : mcpStartup;

        for (const update of CodexEventHandler.createMcpStartupUpdates(filteredStartup)) {
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId,
                update,
            });
        }
    }

    private trackActivePrompt(sessionId: string): ActivePrompt {
        let resolveCompletion: () => void = () => {};
        const completion = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
        });
        let resolveCloseSignal: (value: null) => void = () => {};
        const closeSignal = new Promise<null>((resolve) => {
            resolveCloseSignal = resolve;
        });
        let resolveCancelSignal: (value: null) => void = () => {};
        const cancelSignal = new Promise<null>((resolve) => {
            resolveCancelSignal = resolve;
        });
        const abortController = new AbortController();

        let completed = false;
        let closeRequested = false;
        const activePrompt: ActivePrompt = {
            completion,
            closeSignal,
            cancelSignal,
            signal: abortController.signal,
            currentTurn: null,
            requestCancel: () => {
                if (abortController.signal.aborted) {
                    return;
                }
                abortController.abort();
                resolveCancelSignal(null);
            },
            requestClose: () => {
                if (closeRequested) {
                    return;
                }
                closeRequested = true;
                activePrompt.requestCancel();
                resolveCloseSignal(null);
            },
            complete: () => {
                if (completed) {
                    return;
                }
                completed = true;
                if (this.activePrompts.get(sessionId) === activePrompt) {
                    this.activePrompts.delete(sessionId);
                }
                resolveCompletion();
            },
        };

        this.activePrompts.set(sessionId, activePrompt);
        return activePrompt;
    }

    private cancelBeforeTurnStarted(activePrompt: ActivePrompt): Promise<null> {
        return activePrompt.cancelSignal.then(() => {
            if (activePrompt.currentTurn === null) {
                return null;
            }
            return new Promise<null>(() => {});
        });
    }

    private observePromptRequestCancellation(
        signal: AbortSignal | undefined,
        sessionState: SessionState,
        activePrompt: ActivePrompt,
    ): () => void {
        if (!signal) {
            return () => {};
        }

        const onAbort = () => {
            if (this.activePrompts.get(sessionState.sessionId) !== activePrompt) {
                return;
            }
            logger.log("Prompt request cancelled", {sessionId: sessionState.sessionId});
            activePrompt.requestCancel();
            const turn = activePrompt.currentTurn;
            if (!turn) {
                return;
            }
            void this.requestTurnInterrupt(turn, "Cancel");
        };

        if (signal.aborted) {
            onAbort();
            return () => {};
        }

        signal.addEventListener("abort", onAbort, {once: true});
        return () => signal.removeEventListener("abort", onAbort);
    }

    private createPendingTurnStart(): PendingTurnStart {
        let resolve: (turnId: string | null) => void = () => {};
        const promise = new Promise<string | null>((innerResolve) => {
            resolve = innerResolve;
        });
        return {promise, resolve};
    }

    private async interruptPromptTurn(
        turn: { threadId: string, turnId: string },
        requestName: "Cancel" | "Close",
    ): Promise<void> {
        this.codexAcpClient.markTurnStale({
            threadId: turn.threadId,
            turnId: turn.turnId,
        });
        try {
            await this.requestTurnInterrupt(turn, requestName);
        } finally {
            this.codexAcpClient.resolveTurnInterrupted({
                threadId: turn.threadId,
                turnId: turn.turnId,
            });
        }
    }

    private async requestTurnInterrupt(
        turn: { threadId: string, turnId: string },
        requestName: "Cancel" | "Close",
    ): Promise<void> {
        try {
            await this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
                threadId: turn.threadId,
                turnId: turn.turnId,
            }));
            logger.log(`${requestName} - turnInterrupt succeeded`, {
                sessionId: turn.threadId,
                currentTurnId: turn.turnId,
            });
        } catch (err) {
            logger.error(`${requestName} - turnInterrupt failed`, err);
        }
    }

    private interruptLateStartedTurn(turn: { threadId: string, turnId: string }): void {
        void this.interruptPromptTurn(turn, "Close");
    }

    private promptShouldStop(sessionId: string, activePrompt: ActivePrompt): boolean {
        return activePrompt.signal.aborted || this.activePrompts.get(sessionId) !== activePrompt || this.sessionIsClosing(sessionId);
    }

    private async interruptSessionTurn(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
        resolveInterruptedTurn: boolean,
    ): Promise<void> {
        const turnId = await this.getInterruptibleTurnId(sessionState, requestName);
        if (!turnId) {
            return;
        }

        logger.log(`${requestName} session requested`, {
            sessionId: sessionState.sessionId,
            currentTurnId: turnId,
        });
        if (resolveInterruptedTurn) {
            this.codexAcpClient.markTurnStale({
                threadId: sessionState.sessionId,
                turnId,
            });
        }
        try {
            await this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
                threadId: sessionState.sessionId,
                turnId,
            }));
            logger.log(`${requestName} - turnInterrupt succeeded`, {
                sessionId: sessionState.sessionId,
                currentTurnId: turnId,
            });
        } catch (err) {
            logger.error(`${requestName} - turnInterrupt failed`, err);
        } finally {
            if (resolveInterruptedTurn) {
                this.codexAcpClient.resolveTurnInterrupted({
                    threadId: sessionState.sessionId,
                    turnId,
                });
            }
        }
    }

    private async getInterruptibleTurnId(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
    ): Promise<string | null> {
        if (sessionState.currentTurnId) {
            return sessionState.currentTurnId;
        }

        const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
        if (!pendingTurnStart) {
            logger.log(`${requestName} request rejected: no current turn`, {sessionId: sessionState.sessionId});
            return null;
        }

        if (requestName === "Close") {
            pendingTurnStart.resolve(null);
            return null;
        }

        const turnId = await pendingTurnStart.promise;
        if (!turnId) {
            logger.log(`${requestName} request rejected: no current turn`, {sessionId: sessionState.sessionId});
        }
        return turnId;
    }

    async prompt(
        params: acp.PromptRequest,
        signal?: AbortSignal,
        onTurnStarted?: () => void,
    ): Promise<acp.PromptResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Prompt received", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        const agentFileChangeReportRequest = clientSupportsAgentFileChangeReports(this.clientCapabilities)
            ? parseAgentFileChangeReportRequest(params._meta)
            : null;
        let agentFileChangeReportTurnId: string | null = null;
        let agentFileChangeReportUnavailableReason: AgentFileChangeReportUnavailableReason = "providerError";
        let promptWasCancelled = false;
        let recoverableSessionFailure = sessionState.sessionFailure;
        sessionState.currentTurnId = null;
        sessionState.lastTokenUsage = null;
        const activePrompt = this.trackActivePrompt(params.sessionId);
        let pendingTurnStart: PendingTurnStart | null = null;
        const ensurePendingTurnStart = (): PendingTurnStart => {
            if (pendingTurnStart === null) {
                pendingTurnStart = this.createPendingTurnStart();
                this.pendingTurnStarts.set(params.sessionId, pendingTurnStart);
            }
            return pendingTurnStart;
        };
        const disposePromptRequestCancellation = this.observePromptRequestCancellation(signal, sessionState, activePrompt);
        let eventHandler: CodexEventHandler | null = null;
        let promptNotificationsActive = true;
        const clearRecoveredSessionFailure = async (handler: CodexEventHandler): Promise<void> => {
            await handler.completeSuccessfulTurn(sessionState.currentTurnId);
            const current = sessionState.sessionFailure;
            if (recoverableSessionFailure !== undefined
                && current !== undefined
                && current.id === recoverableSessionFailure.id
                && current.revision === recoverableSessionFailure.revision) {
                await handler.clearSessionFailure();
            }
        };
        const cancelledPromptResponse = (): acp.PromptResponse => {
            promptWasCancelled = true;
            agentFileChangeReportTurnId = null;
            agentFileChangeReportUnavailableReason = "cancelled";
            return this.cancelledPromptResponse(sessionState);
        };

        try {
            const promptEventHandler = new CodexEventHandler(
                this.connection,
                sessionState,
                clientSupportsPlanUpdates(this.clientCapabilities),
                clientSupportsTypedSessionFailures(this.clientCapabilities),
                this.sessionFailureEpoch,
                sessionState.subagents,
            );
            eventHandler = promptEventHandler;
            const permissionLifecycle = this.permissionLifecycleContext(sessionState);
            const permissionContext = permissionLifecycle.beginPrompt();
            const approvalHandler = new CodexApprovalHandler(
                this.connection,
                permissionContext,
                activePrompt.signal,
            );
            const elicitationHandler = new CodexElicitationHandler(
                this.connection,
                permissionContext,
                this.clientCapabilities,
                activePrompt.signal,
            );
            const observeInteraction = async (event: ServerNotification): Promise<void> => {
                permissionContext.handleNotification(event);
                await elicitationHandler.handleNotification(event);
            };
            await this.codexAcpClient.subscribeToSessionEvents(params.sessionId,
                async (event) => {
                    await observeInteraction(event);
                    if (!promptNotificationsActive) {
                        await promptEventHandler.handleSessionScopedNotification(event);
                        return;
                    }
                    const completesActiveTurn = event.method === "turn/completed"
                        && event.params.threadId === sessionState.sessionId
                        && event.params.turn.id === sessionState.currentTurnId;
                    await promptEventHandler.handleNotification(event);
                    if (completesActiveTurn) {
                        // The prompt may remain open for plan approval after its turn has ended. Switch at
                        // the causal boundary so a queued late error cannot enter the completed turn's buffer.
                        promptNotificationsActive = false;
                    }
                },
                approvalHandler,
                elicitationHandler,
                clientSupportsSubagents(this.clientCapabilities),
                observeInteraction,
                childThreadId => promptEventHandler.waitForNativeSubagentSession(childThreadId));

            if (activePrompt.signal.aborted) {
                return cancelledPromptResponse();
            }

            const commandPromise = this.availableCommands.tryHandleCommand(params.prompt, sessionState, {
                onTurnStartPending: () => {
                    ensurePendingTurnStart();
                },
                onTurnStarted: (turnId, threadId) => {
                    const turn = {threadId, turnId};
                    activePrompt.currentTurn = turn;
                    if (this.promptShouldStop(params.sessionId, activePrompt)) {
                        this.interruptLateStartedTurn(turn);
                        return;
                    }
                    sessionState.currentTurnId = turnId;
                    pendingTurnStart?.resolve(turnId);
                    onTurnStarted?.();
                },
                setConfigOption: async (configId, value) => {
                    await this.applySessionConfigOption(sessionState, {
                        sessionId: sessionState.sessionId,
                        configId,
                        value,
                    });
                    const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
                    await session.update({
                        sessionUpdate: "config_option_update",
                        configOptions: this.createSessionConfigOptions(sessionState),
                    });
                },
            });
            void commandPromise.catch((err) => {
                if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                    logger.error(`Command for cancelled prompt ${params.sessionId} failed after prompt returned`, err);
                }
            });
            const commandResult = await Promise.race([
                commandPromise,
                activePrompt.closeSignal,
                this.cancelBeforeTurnStarted(activePrompt),
            ]);
            if (commandResult === null) {
                return cancelledPromptResponse();
            }
            if (commandResult.handled) {
                promptNotificationsActive = false;
                logger.log("Prompt handled by a command");
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                await eventHandler.flushPendingErrors();
                await eventHandler.flushPendingErrorsAsSessionScoped();
                if (commandResult.turnCompleted) {
                    await eventHandler.handleFailedTurn(commandResult.turnCompleted.turn);
                }
                if (commandResult.turnCompleted?.turn.status === "interrupted") {
                    return cancelledPromptResponse();
                }
                const error = eventHandler.getFailure();
                if (error) {
                    // noinspection ExceptionCaughtLocallyJS
                    throw error;
                }
                const terminalFailure = this.terminalFailurePromptResponse(
                    sessionState,
                    eventHandler,
                    commandResult.turnCompleted?.turn.id ?? sessionState.currentTurnId,
                );
                if (terminalFailure) {
                    return terminalFailure;
                }
                if (commandResult.turnCompleted?.turn.status === "completed") {
                    agentFileChangeReportTurnId = commandResult.turnCompleted.turn.id;
                } else if (commandResult.turnCompleted === undefined) {
                    agentFileChangeReportUnavailableReason = "notReported";
                }
                await clearRecoveredSessionFailure(eventHandler);
                return {
                    stopReason: "end_turn",
                    usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

            const effectiveParams = commandResult.prompt === undefined
                ? params
                : {...params, prompt: commandResult.prompt};

            if (this.sessionIsClosing(params.sessionId)) {
                return cancelledPromptResponse();
            }

            const modelId = ModelId.fromString(sessionState.currentModelId);
            const modelLacksReasoning = sessionState.supportedReasoningEfforts.length > 0
                && sessionState.supportedReasoningEfforts.every(e => e.reasoningEffort === "none");

            const disableSummary = sessionState.account?.type === "apiKey" || modelLacksReasoning;
            if (disableSummary) {
                logger.log("Disable reasoning.summary", {
                    sessionId: params.sessionId,
                    reason: sessionState.account?.type === "apiKey" ? "API key" : "model lacks reasoning"
                });
            }

            if (!sessionState.supportedInputModalities.includes("image") && effectiveParams.prompt.some(b => b.type === "image")) {
                throw RequestError.invalidRequest("The current model does not support image input");
            }
            const agentMode = sessionState.agentMode;
            const serviceTier = resolveFastServiceTier(
                sessionState.fastModeEnabled,
                sessionState.currentModelSupportsFast,
            );
            ensurePendingTurnStart();
            const sendPromptPromise = this.runWithProcessCheck(
                () => this.codexAcpClient.sendPrompt(
                    effectiveParams,
                    agentMode,
                    modelId,
                    serviceTier,
                    disableSummary,
                    sessionState.cwd,
                    sessionState.additionalDirectories,
                    (turnId) => {
                        const turn = {threadId: params.sessionId, turnId};
                        activePrompt.currentTurn = turn;
                        if (this.promptShouldStop(params.sessionId, activePrompt)) {
                            this.interruptLateStartedTurn(turn);
                            return;
                        }
                        sessionState.currentTurnId = turnId;
                        pendingTurnStart?.resolve(turnId);
                        onTurnStarted?.();
                    },
                    () => this.promptShouldStop(params.sessionId, activePrompt),
                ));
            void sendPromptPromise.catch((err) => {
                if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                    logger.error(`Prompt for cancelled session ${params.sessionId} failed after prompt returned`, err);
                }
            });
            let turnCompleted = await Promise.race([
                sendPromptPromise,
                activePrompt.closeSignal,
                this.cancelBeforeTurnStarted(activePrompt),
            ]);

            if (turnCompleted === null) {
                return cancelledPromptResponse();
            }

            await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            if (turnCompleted.turn.status === "completed") {
                await eventHandler.waitForNativeSubagents(activePrompt.signal);
                if (activePrompt.signal.aborted) return cancelledPromptResponse();
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            }
            else {
                await eventHandler.finishOutstandingNativeSubagents(
                    turnCompleted.turn.status === "interrupted" ? "cancelled" : "failed",
                );
            }
            await eventHandler.flushPendingErrors();
            await eventHandler.handleFailedTurn(turnCompleted.turn);
            promptNotificationsActive = false;

            if (turnCompleted.turn.status === "interrupted") {
                await eventHandler.flushPendingPlanUpdates();
                return cancelledPromptResponse();
            }

            const error = eventHandler.getFailure();
            if (error) {
                // noinspection ExceptionCaughtLocallyJS
                throw error;
            }
            const terminalFailure = this.terminalFailurePromptResponse(
                sessionState,
                eventHandler,
                turnCompleted.turn.id,
            );
            if (terminalFailure) {
                return terminalFailure;
            }

            await eventHandler.flushPendingPlanUpdates();
            const completedPlan = eventHandler.takeCompletedPlan();
            if (
                completedPlan !== null
                && sessionState.collaborationMode === PLAN_COLLABORATION_MODE
                && !this.promptShouldStop(params.sessionId, activePrompt)
            ) {
                const approved = await this.requestPlanImplementationPermission(
                    sessionState,
                    completedPlan,
                    activePrompt.signal,
                );
                if (this.promptShouldStop(params.sessionId, activePrompt)) {
                    return cancelledPromptResponse();
                }
                if (approved && !this.promptShouldStop(params.sessionId, activePrompt)) {
                    await this.applyCollaborationModeChange(sessionState, DEFAULT_COLLABORATION_MODE);
                    const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
                    await session.update({
                        sessionUpdate: "config_option_update",
                        configOptions: this.createSessionConfigOptions(sessionState),
                    });

                    const implementationRequest: acp.PromptRequest = {
                        sessionId: params.sessionId,
                        prompt: [{type: "text", text: "Implement the approved plan."}],
                    };
                    activePrompt.currentTurn = null;
                    sessionState.currentTurnId = null;
                    const implementationPromise = this.runWithProcessCheck(
                        () => this.codexAcpClient.sendPrompt(
                            implementationRequest,
                            agentMode,
                            modelId,
                            serviceTier,
                            disableSummary,
                            sessionState.cwd,
                            sessionState.additionalDirectories,
                            (turnId) => {
                                const turn = {threadId: params.sessionId, turnId};
                                activePrompt.currentTurn = turn;
                                if (this.promptShouldStop(params.sessionId, activePrompt)) {
                                    this.interruptLateStartedTurn(turn);
                                    return;
                                }
                                sessionState.currentTurnId = turnId;
                                // Keep the approval-to-turn-start gap session-scoped. Once the new turn has
                                // an identity, snapshot any unchanged session failure as its recovery baseline.
                                recoverableSessionFailure = sessionState.sessionFailure;
                                promptNotificationsActive = true;
                            },
                            () => this.promptShouldStop(params.sessionId, activePrompt),
                        ),
                    );
                    void implementationPromise.catch((err) => {
                        if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                            logger.error(`Implementation turn for cancelled prompt ${params.sessionId} failed after prompt returned`, err);
                        }
                    });
                    turnCompleted = await Promise.race([
                        implementationPromise,
                        activePrompt.closeSignal,
                        this.cancelBeforeTurnStarted(activePrompt),
                    ]);

                    if (turnCompleted === null) {
                        return cancelledPromptResponse();
                    }

                    await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                    if (turnCompleted.turn.status === "completed") {
                        await eventHandler.waitForNativeSubagents(activePrompt.signal);
                        if (activePrompt.signal.aborted) return cancelledPromptResponse();
                        await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                    }
                    else {
                        await eventHandler.finishOutstandingNativeSubagents(
                            turnCompleted.turn.status === "interrupted" ? "cancelled" : "failed",
                        );
                    }
                    await eventHandler.flushPendingErrors();
                    await eventHandler.handleFailedTurn(turnCompleted.turn);
                    promptNotificationsActive = false;
                    if (turnCompleted.turn.status === "interrupted") {
                        await eventHandler.flushPendingPlanUpdates();
                        return cancelledPromptResponse();
                    }

                    const implementationError = eventHandler.getFailure();
                    if (implementationError) {
                        throw implementationError;
                    }
                    const implementationFailure = this.terminalFailurePromptResponse(
                        sessionState,
                        eventHandler,
                        turnCompleted.turn.id,
                    );
                    if (implementationFailure) {
                        return implementationFailure;
                    }
                }
            }
            if (turnCompleted.turn.status === "completed") {
                agentFileChangeReportTurnId = turnCompleted.turn.id;
            }

            await clearRecoveredSessionFailure(eventHandler);

            await this.publishFallbackSessionTitle(
                sessionState,
                this.createPromptFallbackTitle(params.prompt),
            );

            return {
                stopReason: "end_turn",
                usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                _meta: this.buildQuotaMeta(sessionState),
            };
        } catch (err) {
            logger.error(`Prompt for session ${params.sessionId} failed`, err);
            if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)) {
                return cancelledPromptResponse();
            }
            agentFileChangeReportTurnId = null;
            agentFileChangeReportUnavailableReason = "providerError";
            const isProcessExit = err instanceof RequestError
                && err.code === CODEX_PROCESS_EXITED_ERROR_CODE;
            const isUnexpectedFailure = !(err instanceof RequestError);
            if (eventHandler !== null
                && clientSupportsTypedSessionFailures(this.clientCapabilities)
                && (isProcessExit || isUnexpectedFailure)) {
                eventHandler.recordSyntheticTerminalFailure(
                    isProcessExit ? "transport_lost" : "internal_error",
                    sessionState.currentTurnId,
                );
                const failureResponse = this.terminalFailurePromptResponse(
                    sessionState,
                    eventHandler,
                    sessionState.currentTurnId,
                    true,
                );
                if (failureResponse !== null) {
                    return failureResponse;
                }
            }
            throw err;
        } finally {
            // The app-server subscription is session-scoped and outlives this prompt. Flip routing before
            // awaiting disposal so queued late notifications cannot enter prompt-local buffers.
            promptNotificationsActive = false;
            try {
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                await eventHandler?.finishOutstandingNativeSubagents(
                    promptWasCancelled || activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)
                        ? "cancelled"
                        : "failed",
                );
            } catch (error) {
                logger.error("Failed to publish terminal subagent state during prompt cleanup", error);
            }
            if (agentFileChangeReportRequest !== null) {
                await this.publishAgentFileChangeReport(
                    sessionState,
                    agentFileChangeReportTurnId,
                    agentFileChangeReportRequest,
                    agentFileChangeReportUnavailableReason,
                    activePrompt.signal,
                );
            }
            logger.log("Prompt completed", {sessionId: params.sessionId});
            await eventHandler?.dispose();
            disposePromptRequestCancellation();
            sessionState.currentTurnId = null;
            const registeredPendingTurnStart = this.pendingTurnStarts.get(params.sessionId);
            if (registeredPendingTurnStart !== undefined) {
                this.pendingTurnStarts.delete(params.sessionId);
                registeredPendingTurnStart.resolve(null);
            }
            activePrompt.complete();
        }
    }

    private async requestPlanImplementationPermission(
        sessionState: SessionState,
        plan: CompletedPlan,
        cancellationSignal: AbortSignal,
    ): Promise<boolean> {
        const toolCallId = planImplementationToolCallId(plan);
        try {
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                planImplementationPermissionRequest(sessionState.sessionId, plan),
                {cancellationSignal},
            );
            const approved = planImplementationApproved(response);
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId: sessionState.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: "completed",
                    rawOutput: approved
                        ? "User approved the plan."
                        : "User kept the session in plan mode.",
                },
            });
            return approved;
        } catch (error) {
            logger.error("Error requesting plan implementation permission", error);
            return false;
        }
    }

    private cancelledPromptResponse(sessionState: SessionState): acp.PromptResponse {
        return {
            stopReason: "cancelled",
            usage: this.buildPromptUsage(sessionState.lastTokenUsage),
            _meta: this.buildQuotaMeta(sessionState),
        };
    }

    private terminalFailurePromptResponse(
        sessionState: SessionState,
        eventHandler: CodexEventHandler,
        turnId: string | null,
        allowUnattributed = false,
    ): acp.PromptResponse | null {
        const failureMeta = eventHandler.getTerminalSessionFailureMeta(turnId, allowUnattributed);
        if (failureMeta === null) {
            return null;
        }
        return {
            stopReason: "end_turn",
            usage: this.buildPromptUsage(sessionState.lastTokenUsage),
            _meta: {
                ...this.buildQuotaMeta(sessionState),
                ...failureMeta,
            },
        };
    }

    private buildQuotaMeta(sessionState: SessionState): { quota: QuotaMeta } {
        const lastTokenUsage = sessionState.lastTokenUsage;

        // Remove the "[reasoning-level]" suffix from currentModelId if present
        const modelName = sessionState.currentModelId.replace(/\[.*?]$/, '');

        // FIXME: currently all tokens are reported for the current model
        const modelUsage = (lastTokenUsage != null)
            ? [{ model: modelName, token_count: lastTokenUsage }]
            : [];

        return {
            quota: {
                token_count: sessionState.lastTokenUsage,
                model_usage: modelUsage
            }
        };
    }

    private buildPromptUsage(lastTokenUsage: TokenCount | null): acp.Usage | null {
        if (lastTokenUsage == null) {
            return null;
        }
        return toPromptUsage(lastTokenUsage);
    }

    private async runWithProcessCheck<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (err) {
            const exitCode = this.getExitCode();
            const requestErrorCode = CODEX_PROCESS_EXITED_ERROR_CODE;
            if (exitCode == 3221225781) {
                throw new RequestError(requestErrorCode, `VC++ redistributable should be installed`);
            }
            if (exitCode !== null) {
                const stderr = this.getRecentStderr().trim();
                const detail = stderr ? `:\n${stderr}` : "";
                throw new RequestError(requestErrorCode, `Codex process has exited with code ${exitCode}${detail}`);
            }
            throw err;
        }
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) {
            logger.log("Cancel request rejected: session not found", {sessionId: params.sessionId});
            return;
        }

        // After turnInterrupt(), Codex will send turn/completed, which naturally completes awaitTurnCompleted().
        await this.interruptSessionTurn(sessionState, "Cancel", false);
    }
}

function mergeHistoryUpdates(
    responseItemFallbackUpdates: UpdateSessionEvent[],
    threadUpdates: UpdateSessionEvent[],
): UpdateSessionEvent[] {
    const merged: UpdateSessionEvent[] = [];
    const seen = new Set<string>();
    let fallbackIndex = 0;

    const pushUpdate = (update: UpdateSessionEvent) => {
        const key = historyUpdateKey(update);
        if (key && seen.has(key)) {
            return;
        }
        if (key) {
            seen.add(key);
        }
        merged.push(update);
    };

    const flushFallbackBeforeMatchingDuplicate = (targetUpdate: UpdateSessionEvent): void => {
        const targetKey = historyUpdateKey(targetUpdate);
        const targetContentKey = historyUpdateContentKey(targetUpdate);
        if (!targetKey && !targetContentKey) {
            return;
        }

        const matchIndex = responseItemFallbackUpdates.findIndex((update, index) => (
            index >= fallbackIndex
            && (
                (targetKey !== null && historyUpdateKey(update) === targetKey)
                || (targetContentKey !== null && historyUpdateContentKey(update) === targetContentKey)
            )
        ));
        if (matchIndex === -1) {
            return;
        }

        while (fallbackIndex < matchIndex) {
            pushUpdate(responseItemFallbackUpdates[fallbackIndex]!);
            fallbackIndex += 1;
        }
        fallbackIndex += 1;
    };

    for (const update of threadUpdates) {
        flushFallbackBeforeMatchingDuplicate(update);
        pushUpdate(update);
    }

    while (fallbackIndex < responseItemFallbackUpdates.length) {
        pushUpdate(responseItemFallbackUpdates[fallbackIndex]!);
        fallbackIndex += 1;
    }

    return merged;
}

function historyUpdateKey(update: UpdateSessionEvent): string | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return `${update.sessionUpdate}:${update.messageId ?? ""}:${JSON.stringify(update.content)}`;
        case "tool_call":
            return `tool_call:${update.toolCallId}:start`;
        case "tool_call_update":
            return `tool_call:${update.toolCallId}:update`;
        default:
            return null;
    }
}

function historyUpdateContentKey(update: UpdateSessionEvent): string | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return `${update.sessionUpdate}:${JSON.stringify(update.content)}`;
        default:
            return historyUpdateKey(update);
    }
}

function getRequestedMcpServerNames(mcpServers: Array<acp.McpServer>): Array<string> {
    return Array.from(new Set(mcpServers.map(server => sanitizeMcpServerName(server.name))));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
