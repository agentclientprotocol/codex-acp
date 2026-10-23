import * as acp from "@agentclientprotocol/sdk/unstable";
import {RequestError, type SessionId, type SessionModeState} from "@agentclientprotocol/sdk/unstable";
import {CodexEventHandler, type CompletedPlan, failureWasShownAsMessage} from "./CodexEventHandler";
import {attachmentFileUri, desktopAttachmentHistory} from "./DesktopAttachmentHistory";
import {CodexApprovalHandler} from "./permissions/CodexApprovalHandler";
import {PermissionLifecycleContext} from "./permissions/lifecycle";
import {CodexElicitationHandler} from "./CodexElicitationHandler";
import {type CodexAuthRequest, getCodexAuthMethods, getCodexAuthMethodsV2, isCodexAuthRequest} from "./CodexAuthMethod";
import {clientSupportsUrlElicitation} from "./ElicitationCapabilities";
import {createMcpServerSignIn, type McpServerSignIn} from "./mcp/McpServerSignIn";
import {getRequestedMcpServerNames, McpSessionStartup, parseMcpStartupAwaitTimeoutMs} from "./mcp/McpSessionStartup";
import {
    CodexAcpClient,
    type JsonObject,
    OPENAI_PROVIDER_ID,
    type SessionMetadata,
    type SessionMetadataWithThread,
    type SubagentHistoryItem,
    type UrlElicitationRequester
} from "./CodexAcpClient";
import {
    type ApprovalHandler,
    CodexAppServerClient,
    type ElicitationHandler,
} from "./CodexAppServerClient";
import {
    isAccountReadAccountChangedError,
    isAccountReadAuthFailureError,
    isAccountReadUnavailableError,
    isNoActiveTurnError,
    parseExpectedActiveTurnMismatch,
} from "./CodexThreadErrors";
import {requiresLogout} from "./CodexErrorExplanations";
import {type CodexConnection} from "./CodexJsonRpcConnection";
import {AppServerRecovery, recoveryLimitsFromEnv} from "./app-server-recovery/AppServerRecovery";
import {
    CODEX_PROCESS_EXITED_ERROR_CODE,
    SessionReplacedError,
    ThreadRefusedError,
    UnpersistedSessionLostError,
} from "./app-server-recovery/AppServerExit";
import {CodexAppServerSupervisor} from "./app-server-recovery/CodexAppServerSupervisor";
import {lossAwareConnection} from "./app-server-recovery/LossAwareConnection";
import {AppServerConnectionLostError} from "./app-server-recovery/ConnectionLoss";
import {
    type AcpClientConnection,
    ACPSessionConnection,
    type AcpV2ClientConnection,
    AcpV2Connection,
    type ReplayMessageKind,
    type UpdateSessionEvent,
} from "./ACPSessionConnection";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {toV1ClientCapabilitiesView} from "./AcpV2ClientCapabilities";
import {toV1SetSessionConfigOptionRequest, toV2ConfigOptions} from "./AcpV2ConfigOptions";
import {toV2AvailableCommands} from "./AcpV2SessionUpdate";
import {changesSystemPrompt, clientSystemPromptText, toV1SystemPrompt, type SessionInstructions} from "./ClientSystemPrompt";
import {
    isInsertedUserMessage,
    postInsertionFailureText,
    toV1PromptRequest,
    toV2Failure,
    toV2IdleState,
    type UserMessageInsertion,
} from "./AcpV2Prompt";
import type {InputModality, ReasoningEffort, ServerNotification} from "./app-server";
import type {
    Account,
    AccountUpdatedNotification,
    GetAccountResponse,
    Model,
    ReasoningEffortOption,
    Thread,
    ThreadGoal,
    ThreadItem,
    ThreadItemEntry,
    Turn,
    TurnStatus,
    UserInput
} from "./app-server/v2";
import type {RateLimitsMap} from "./RateLimitsMap";
import {ModelId} from "./ModelId";
import {normalizeSessionTitle} from "./SessionTitle";
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
    formatModelDisplayName,
    MODEL_CONFIG_ID,
    REASONING_EFFORT_CONFIG_ID,
} from "./ModelConfigOption";
import type {TokenCount} from "./TokenCount";
import {PromptTokenUsage, toPromptUsage, ZERO_TOKEN_COUNT} from "./TokenCount";
import {CodexCommands} from "./CodexCommands";
import {SteeringQueue} from "./SteeringQueue";
import type {QuotaMeta} from "./QuotaMeta";
import {logger} from "./Logger";
import {settledWithin} from "./StdUtils";
import type {ToolCallReports} from "./ToolCallReports";
import {ToolCallReportingConnection} from "./ToolCallReportingConnection";
import {type AcpMcpServer, getMcpServerName, type WithAcpMcpServers} from "./McpServerConfig";
import {
    AUTH_STATUS_META_KEY,
    AUTH_STATUS_UPDATE_METHOD,
    authStatusCapability,
    type AuthStatus,
    type AuthenticationStatusResponse,
    GOAL_CONTROL_ACTIONS,
    GOAL_CONTROL_METHOD,
    GOAL_EXTENSION_VERSION,
    isExtMethodRequest,
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
} from "./AcpExtensions";
import {AcpToolCallRenderer} from "./tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "./tool-calls/ClientCapabilities";
import {CollabAgentReporter} from "./tool-calls/reporters/CollabAgentReporter";
import {CommandReporter} from "./tool-calls/reporters/CommandReporter";
import {CompactionReporter} from "./tool-calls/reporters/CompactionReporter";
import {DynamicToolReporter} from "./tool-calls/reporters/DynamicToolReporter";
import {FileChangeReporter} from "./tool-calls/reporters/FileChangeReporter";
import {ImageGenerationReporter} from "./tool-calls/reporters/ImageGenerationReporter";
import {ImageViewReporter} from "./tool-calls/reporters/ImageViewReporter";
import {McpToolReporter} from "./tool-calls/reporters/McpToolReporter";
import {PlanReviewReporter} from "./tool-calls/reporters/PlanReviewReporter";
import {SubagentActivityReporter} from "./tool-calls/reporters/SubagentActivityReporter";
import {WebSearchReporter} from "./tool-calls/reporters/WebSearchReporter";
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
import {clientSupportsNotices} from "./SessionNotice";
import {
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
    createMessagePhaseMeta,
    createUserMessageChunk,
} from "./ContentChunks";
import {
    goalSessionInfoUpdate,
    sameThreadGoalSnapshot,
    type ThreadGoalSnapshot,
    toThreadGoalSnapshot,
} from "./ThreadGoalSnapshot";
import {
    subagentProtocol,
    type SubagentAwareSessionCapabilities,
} from "./subagents/AcpSubagents";
import {CodexSubagentEventRouter} from "./subagents/CodexSubagentEventRouter";
import {StandardSubagentEventRouter} from "./subagents/StandardSubagentEventRouter";
import {SubagentAssociations} from "./subagents/SubagentAssociations";
import {SubagentInteractionHandlers} from "./subagents/SubagentInteractionHandlers";
import type {SubagentEventRouter} from "./subagents/SubagentEventRouter";
import {isRootAgentPath, nameFromAgentPath} from "./subagents/CodexAgentPath";
import {listCodexHooks, trustCodexHooks, type CodexHookIdentity} from "./CodexHookTrust";
import type {HooksListEntry} from "./app-server/v2/HooksListEntry";
import {
    accountFromUpdated,
    agentConfiguredProviderStatus,
    fromAccount,
    fromAccountUpdated,
    gatewayStatus,
    sameAuthStatus,
} from "./AuthStatusMeta";
import {randomUUID} from "node:crypto";
import {TitleGenerator} from "./TitleGenerator";
import {once} from "node:events";
import {
    AIR_AGENT_FILE_CHANGE_REPORT_KEY,
    AIR_CUSTOM_INSTRUCTIONS_KEY,
    AIR_ASYNC_TASKS_KEY,
    AIR_CODEX_HOOKS_KEY,
    AIR_DIFF_PATCH_KEY,
    AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
    AIR_PLAN_CONTENT_DELTA_KEY,
    AIR_RAW_INPUT_RENDERING_KEY,
    AIR_RECOMMENDED_CONFIG_VALUE_KEY,
    AIR_EXTENSION_CAPABILITIES_KEY,
    AIR_EXTENSION_VERSION,
    AIR_GOAL_KEY,
    AIR_EXTENSION_VERSION_KEY,
    AIR_META_KEY,
    AIR_SESSION_FAILURE_KEY,
    clientSupportsAirCapability,
    JETBRAINS_META_KEY,
} from "./AirExtension";
import {SessionIndexService} from "./SessionIndexService";
import type {SessionIndexTitleState} from "./SessionIndexTitles";
import {ASYNC_TASK_STOP_METHOD} from "./async-tasks/AsyncTaskExtension";
import {CodexBackgroundTerminalTasks} from "./async-tasks/CodexBackgroundTerminalTasks";
import {clientSupportsCompaction, CodexSessionCompactions, createCompactionUpdate} from "./CodexSessionCompactions";
import {CodexSessionToolCalls} from "./CodexSessionToolCalls";
import {
    type AgentFileChangeReport,
    type AgentFileChangeReportRequest,
    type AgentFileChangeReportUnavailableReason,
    type AgentFileChangeWorkspace,
    AgentFileChangeReportError,
    captureAgentFileChangeWorkspace,
    createReportedAgentFileChangeReport,
    createUnavailableAgentFileChangeReport,
    parseAgentFileChangeReportRequest,
} from "./AgentFileChangeReport";


export interface SessionState extends SessionIndexTitleState {
    sessionId: string,
    instructions?: SessionInstructions;
    currentModelId: string,
    availableModels: Array<Model>,
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    supportedInputModalities: Array<InputModality>,
    agentMode: AgentMode,
    collaborationMode: ModeKind,
    /** The active turn: its completion, errors and stop reason are matched against this id. */
    currentTurnId: string | null;
    /**
     * The id from the latest `turn/started`, which `turn/interrupt` and `turn/steer` need. It
     * differs from `currentTurnId` only for a review: Codex reports the review's events and
     * completion under the parent turn id, but treats the reviewer child turn as the running one.
     */
    interruptTurnId: string | null;
    /**
     * The Codex-reported turn currently running on this thread (`turn/started` to
     * `turn/completed`), tracked independently of whether a `session/prompt` started it. Backs
     * the v2 "Codex turn running" busy signal and the `running`/`idle` states sent for a turn no
     * v2 prompt owns (an auto goal continuation, or a turn Codex starts right after
     * `session/resume`).
     */
    codexReportedRunningTurnId: string | null;
    lastTokenUsage: TokenCount | null;
    totalTokenUsage: TokenCount | null;
    /** The token usage of the current or last prompt, which its PromptResponse reports. */
    promptTokenUsage: PromptTokenUsage | null;
    /** Whether the thread may have token usage from before this session, as a loaded, resumed or forked thread. */
    threadHasHistory: boolean;
    modelContextWindow: number | null;
    rateLimits: RateLimitsMap | null;
    account: Account | null;
    authConfigured: boolean;
    authProvider: string | null;
    cwd: string;
    additionalDirectories: string[];
    mcpServers?: Array<AcpMcpServer>;
    fastModeEnabled: boolean;
    currentModelSupportsFast: boolean;
    sessionMcpServers?: Array<string>;
    /** The capability choices of the client for tool call and plan reports. */
    clientCapabilities: ClientCapabilities;
    currentGoal?: ThreadGoalSnapshot | null;
    goalRevision: number;
    sessionTitle: string | null;
    sessionTitleSource: "unset" | "fallback" | "explicit" | "unknown";
    sessionFailure?: SessionFailure;
    titleGen?: TitleGenerator;
    subagents: SubagentEventRouter;
    subagentTransition?: Promise<void>;
    asyncTasks: CodexBackgroundTerminalTasks;
    compactions: CodexSessionCompactions;
    toolCallReports: ToolCallReports;
    /**
     * Tool-call items reported `item/started` but not yet `item/completed`, for item types
     * with no outstanding-item tracker of their own. A provider restart's close-out fails
     * whatever is still open here for a turn the dead app-server process never finished.
     */
    openToolCalls: CodexSessionToolCalls;
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

/**
 * How long `session/load` waits for an in-flight title generation to settle
 * before answering anyway. Generous enough for a title model round-trip, short
 * enough that a wedged generation cannot hold a load open.
 */
const TITLE_GENERATION_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Backoff for re-sending `turn/interrupt` when Codex reports the turn is not
 * interruptible yet. Covers the sub-second window between a turn's first
 * streamed event -- which is what prompts a client to cancel in the first
 * place -- and Codex registering the turn as interruptible.
 */
const NO_ACTIVE_TURN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

/**
 * How long after its start `session/load` waits for the account read when `thread/resume` is done or failed.
 * A missing login needs no network call, so the read answers fast and the load fails with `auth_required`.
 * A ChatGPT login waits for the ChatGPT backend, which the app-server waits for up to 15 s.
 * Such a read can still find a login that does not work, for example a revoked token (401).
 * The load then answers without the read, and `applyLateAccountRead` reports the answer later.
 */
const ACCOUNT_READ_LOAD_GRACE_MS = 1_000;

/** A promise plus its own `resolve`, for settling a promise from outside its executor. */
function createDeferred<T>(): [Promise<T>, (value: T) => void] {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return [promise, resolve];
}

/**
 * Maps a turn id to the id Codex accepts for `turn/interrupt` and `turn/steer`. For the session's
 * current turn that is the latest `turn/started` id (a review's child turn), once one arrived.
 */
function codexRunningTurnId(sessionState: SessionState, turnId: string): string {
    return sessionState.currentTurnId === turnId
        ? sessionState.interruptTurnId ?? turnId
        : turnId;
}

/**
 * Legacy stop reason for an unowned runtime turn. Standard v2 failure details are supplied separately.
 */
function stopReasonForUnownedTurn(status: TurnStatus): acp.StopReason {
    switch (status) {
        case "completed":
        case "failed":
            return "end_turn";
        case "interrupted":
            return "cancelled";
        case "inProgress":
            // turn/completed never reports an in-progress turn.
            return "end_turn";
    }
}

/**
 * Approval/elicitation handlers for the baseline Codex turn tracker installed before any prompt
 * has run. They answer exactly as app-server already defaults to for a thread with no
 * handler registered, since nothing here can meaningfully act on a request until a real prompt
 * is issued.
 */
const DENY_ALL_APPROVALS: ApprovalHandler = {
    handleCommandExecution: async () => ({decision: "cancel"}),
    handleFileChange: async () => ({decision: "cancel"}),
    handlePermissionsRequest: async () => ({permissions: {}, scope: "turn", strictAutoReview: false}),
};

const DENY_ALL_ELICITATIONS: ElicitationHandler = {
    handleElicitation: async () => ({action: "cancel", content: null, _meta: null}),
    handleUserInput: async () => ({answers: {}}),
};

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

/**
 * An account read that a session open already has. `null` means no read.
 * `"unavailable"` means a read that failed without an answer about the login, see {@link isAccountReadUnavailableError}.
 */
type KnownAccount = GetAccountResponse | "unavailable" | null;

/** True for the `auth_required` error that {@link CodexAcpServer.checkAuthorization} throws. */
function isAuthRequiredError(error: unknown): boolean {
    return error instanceof RequestError && error.code === RequestError.authRequired().code;
}

interface PendingTurnStart {
    promise: Promise<string | null>;
    resolve: (turnId: string | null) => void;
}

/**
 * One session's place in the shared per-session turn-start FIFO (see
 * `CodexAcpServer.acquireTurnStartReservation`). `wait` resolves once every earlier reservation
 * on the session has released; `release` must be called exactly once, by whoever ends up owning
 * the turn this reservation was taken for, so the next queued starter can proceed.
 *
 * `needsWait` is false when there was nothing to wait for (a fresh session, or the previous
 * holder already released). Callers should skip `await wait` in that case: awaiting an
 * already-resolved promise still costs a microtask tick, which is enough to reorder synchronous
 * setup (event-subscription registration, etc.) against a caller that fires a prompt without
 * awaiting it and immediately does other synchronous work.
 */
interface TurnStartReservation {
    wait: Promise<void>;
    needsWait: boolean;
    release: () => void;
}

interface ActivePrompt {
    completion: Promise<void>;
    closeSignal: Promise<null>;
    cancelSignal: Promise<null>;
    signal: AbortSignal;
    /**
     * Aborted for outbound permission/elicitation requests only (plain `session/cancel`,
     * `requestCancel`, `requestClose`). Kept separate from `signal`, which also drives pre-turn
     * prompt flow (`cancelBeforeTurnStarted`, local commands, native-subagent waits,
     * `interruptLateStartedTurn`) and must keep its current behavior on plain `session/cancel`.
     */
    interactionSignal: AbortSignal;
    /** Set by plain `session/cancel` so the plan-review branch can detect cancellation without `signal` being aborted. */
    cancelRequested: boolean;
    currentTurn: { threadId: string, turnId: string } | null;
    requestCancel: () => void;
    requestClose: () => void;
    abortInteractions: () => void;
    complete: () => void;
    /** The client sent `session/cancel` for this prompt. A prompt that ends after it answers `cancelled`. */
    clientCancelled: boolean;
    clientCancelSignal: Promise<null>;
    requestClientCancel: () => void;
}

export interface CodexProcessState {
    connection: CodexConnection;
    codexPath: string | undefined;
    config: JsonObject | undefined;
    appServerStartupArgs: string[];
    modelProvider: string | undefined;
    stderr: string;
    stderrProcess?: CodexConnection["process"];
    /** Owns the app-server child; created by `index.ts`, or by the server for a state without one. */
    supervisor?: CodexAppServerSupervisor;
}

export class CodexAcpServer {
    private codexAcpClient: CodexAcpClient;
    private readonly connection: AcpClientConnection;
    private readonly mcpServerSignIn: McpServerSignIn;
    private readonly reportingConnection: ToolCallReportingConnection;
    /** ACP protocol version of the connection this agent serves, fixed by the protocol router. */
    readonly protocolVersion: 1 | 2;
    /** The v2 client handle; `null` on a v1 connection. */
    private readonly v2Connection: AcpV2ClientConnection | null;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;
    private readonly getRecentStderr: () => string;
    private readonly sessionFailureEpoch: string;
    private availableCommands: CodexCommands;
    private clientInfo: acp.Implementation | null;
    private clientCapabilities: acp.ClientCapabilities | null;
    /** The capability choices of the client for tool call and plan reports. */
    private capabilities: ClientCapabilities;
    private booleanConfigOptionsSupported: boolean;
    /** Last `authStatus` pushed to the client; used to suppress duplicates. */
    private currentAuthStatus: AuthStatus | null;
    /**
     * The last known account of the agent. Every successful account read and every `account/updated` sets it,
     * and a logout clears it. A session open takes it when the account read is unavailable.
     */
    private lastReadAccount: Account | null = null;
    /**
     * Counts the calls of {@link setAuthStatus}, also the calls that push nothing. A late account read
     * compares it with the value at the start of the read: a change means a newer status.
     */
    private authStatusVersion = 0;

    private readonly sessions: Map<string, SessionState>;
    private readonly subagentAssociations = new SubagentAssociations();
    private readonly subagentInteractionHandlers = new WeakMap<StandardSubagentEventRouter, SubagentInteractionHandlers>();
    private readonly mcpSessionStartup: McpSessionStartup;
    private readonly pendingTurnStarts: Map<string, PendingTurnStart>;
    private readonly activePrompts: Map<string, ActivePrompt>;
    /** Tail of the per-session turn-start FIFO; see `acquireTurnStartReservation`. */
    private readonly turnStartQueueTail: Map<string, {promise: Promise<void>; settled: boolean}>;
    private readonly steeringQueues: Map<string, SteeringQueue>;
    /**
     * Steers awaiting their `userMessage` landing, keyed by the minted `clientUserMessageId`
     * passed to `turn/steer`. Used only to show a v2 live `user_message` when a steer injected
     * into an already-running turn lands (there is no `prompt()` call to hook into for that
     * path); v1 has nothing to emit. A steer that starts a new turn instead goes through
     * `prompt()`'s own `UserMessageInsertion` tracking and never enters this map.
     */
    private readonly pendingSteerLandings: Map<string, {sessionId: string; prompt: acp.ContentBlock[]}>;
    /** Sessions with a v2 prompt that has not finished yet, including before its turn starts. */
    private readonly v2PromptsInFlight = new Set<string>();
    private readonly instructionUpdates = new Set<string>();
    /**
     * Per-session callbacks that abort a v2 `session/prompt` still waiting in the turn-start FIFO
     * (queued behind a running turn, not yet inserted). `session/cancel`/`session/close` drop the
     * whole queue for a session by invoking every registered callback here.
     */
    private readonly queuedV2PromptCancellers = new Map<string, Set<() => void>>();
    private readonly closingSessions: Map<string, number>;
    private readonly sessionGenerations: Map<string, number>;
    private readonly sessionOpenGenerations: Map<string, number>;
    private readonly permissionLifecycleContexts: WeakMap<SessionState, PermissionLifecycleContext>;
    private readonly codexProcessState: CodexProcessState | null;
    /** Brings the app-server back after a crash; `null` without a process state (tests). */
    private readonly recovery: AppServerRecovery<SessionState> | null;
    private initializeRequest: Pick<acp.InitializeRequest, "clientInfo"> | null = null;
    private providerUpdate: Promise<void> | null = null;
    /**
     * Numbers `providers/set` and `providers/disable` requests in arrival order. A listing finishing after a newer
     * request was applied is dropped; a newer request that failed drops nothing.
     */
    private providerRequests = 0;
    private appliedProviderRequest = 0;
    /** The AIR `sessionIndex` extension, see `SessionIndexService.ts`. */
    readonly sessionIndex = new SessionIndexService({
        connection: () => this.connection,
        client: () => this.codexAcpClient,
        ensureAppServer: async () => {
            await this.ensureAppServer();
        },
        runWithProcessCheck: (operation) => this.runWithProcessCheck(operation),
        session: (sessionId) => this.sessions.get(sessionId),
        hasLocalSession: (sessionId) => this.hasLocalSession(sessionId),
        closeSession: async (sessionId) => {
            await this.closeSession({sessionId});
        },
        beginSessionCloseFence: (sessionId) => this.beginSessionCloseFence(sessionId),
        endSessionCloseFence: (sessionId) => this.endSessionCloseFence(sessionId),
    });

    constructor(
        connection: AcpClientConnection | AcpV2Connection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
        getExitCode?: () => number | null,
        getRecentStderr?: () => string,
        codexProcessState?: CodexProcessState,
    ) {
        this.sessions = new Map();
        this.pendingTurnStarts = new Map();
        this.activePrompts = new Map();
        this.turnStartQueueTail = new Map();
        this.steeringQueues = new Map();
        this.pendingSteerLandings = new Map();
        this.closingSessions = new Map();
        this.sessionGenerations = new Map();
        this.sessionOpenGenerations = new Map();
        this.permissionLifecycleContexts = new WeakMap();
        if (connection instanceof AcpV2Connection) {
            this.protocolVersion = 2;
            this.v2Connection = connection.client;
            this.reportingConnection = new ToolCallReportingConnection(connection.extensionOnlyV1View());
            this.connection = this.reportingConnection.asClientConnection();
            connection.registerView(this.connection);
            // Foreground work includes adapter pauses between runtime turns, such as plan review.
            connection.setTurnRunningCheck((sessionId) => this.isSessionBusy(sessionId));
        } else {
            this.protocolVersion = 1;
            this.v2Connection = null;
            this.reportingConnection = new ToolCallReportingConnection(connection);
            this.connection = this.reportingConnection.asClientConnection();
        }
        this.codexAcpClient = codexAcpClient;
        this.mcpServerSignIn = createMcpServerSignIn(
            this.connection,
            () => this.codexAcpClient,
            () => this.clientCapabilities,
        );
        this.mcpSessionStartup = new McpSessionStartup(
            this.connection,
            () => this.codexAcpClient,
            (operation) => this.runWithProcessCheck(operation),
            this.mcpServerSignIn,
            () => this.capabilities,
            (sessionId) => this.sessions.has(sessionId) && !this.sessionIsClosing(sessionId),
        );
        this.defaultAuthRequest = defaultAuthRequest ?? null;
        this.codexProcessState = codexProcessState ?? null;
        this.captureStderr();
        this.getExitCode = getExitCode ?? (() => this.codexProcessState?.connection.process.exitCode ?? null);
        this.getRecentStderr = getRecentStderr ?? (() => this.codexProcessState?.stderr ?? "");
        this.sessionFailureEpoch = randomUUID();
        this.clientInfo = null;
        this.clientCapabilities = null;
        this.capabilities = ClientCapabilities.DEFAULT;
        this.booleanConfigOptionsSupported = false;
        this.currentAuthStatus = null;
        this.availableCommands = this.createAvailableCommands(codexAcpClient);
        this.recovery = this.createRecovery();
    }

    private createAvailableCommands(client: CodexAcpClient): CodexCommands {
        return new CodexCommands(
            this.connection,
            client,
            (operation) => this.runWithProcessCheck(operation),
            () => this.refreshAuthState(null),
            this.mcpServerSignIn,
        );
    }

    usesStandardSubagents(): boolean {
        return subagentProtocol(this.clientCapabilities, this.protocolVersion) === "standard";
    }

    private supportsNativeSubagents(): boolean {
        return subagentProtocol(this.clientCapabilities, this.protocolVersion) !== "hidden";
    }

    private createSubagentRouter(sessionId: string, replay = false): SubagentEventRouter {
        const existing = this.sessions.get(sessionId)?.subagents;
        // Child requests and work belong to the conversation, not a particular load or prompt handler.
        if (this.usesStandardSubagents() && existing instanceof StandardSubagentEventRouter && !existing.isRetired()) {
            return existing;
        }
        const session = new ACPSessionConnection(this.connection, sessionId);
        const release = (childId: string) => this.reportingConnection.reports.releaseOpen(childId);
        const router = this.usesStandardSubagents()
            ? new StandardSubagentEventRouter(sessionId, session, this.subagentAssociations, release, this.capabilities, replay,
                this.sessions.get(sessionId)?.subagentTransition,
                threadId => this.codexAcpClient.appServerClient.runningTurnId(threadId))
            : new CodexSubagentEventRouter(sessionId, this.supportsNativeSubagents(), session, release);
        if (router instanceof StandardSubagentEventRouter) this.getSubagentInteractionHandlers(router, sessionId);
        return router;
    }

    private getSubagentInteractionHandlers(router: StandardSubagentEventRouter, rootSessionId: string): SubagentInteractionHandlers {
        const existing = this.subagentInteractionHandlers.get(router);
        if (existing) return existing;
        const handlers = new SubagentInteractionHandlers(
            this.connection, rootSessionId, this.clientCapabilities, new AcpToolCallRenderer(this.capabilities),
        );
        router.setInteractionObserver((event, sessionId) => handlers.observe(event, sessionId));
        this.subagentInteractionHandlers.set(router, handlers);
        return handlers;
    }

    private childInteractions(sessionId: string): {approvals: ApprovalHandler; elicitations: ElicitationHandler} | undefined {
        const association = this.subagentAssociations.get(sessionId);
        if (!association) return undefined;
        const router = this.sessions.get(association.rootSessionId)?.subagents;
        return router instanceof StandardSubagentEventRouter && !router.isRetired()
            ? this.getSubagentInteractionHandlers(router, association.rootSessionId)
            : {approvals: DENY_ALL_APPROVALS, elicitations: DENY_ALL_ELICITATIONS};
    }

    private routeChildApprovals(fallback: ApprovalHandler): ApprovalHandler {
        return {
            handleCommandExecution: params => (this.childInteractions(params.threadId)?.approvals ?? fallback).handleCommandExecution(params),
            handleFileChange: params => (this.childInteractions(params.threadId)?.approvals ?? fallback).handleFileChange(params),
            handlePermissionsRequest: params => (this.childInteractions(params.threadId)?.approvals ?? fallback).handlePermissionsRequest(params),
        };
    }

    private routeChildElicitations(fallback: ElicitationHandler): ElicitationHandler {
        return {
            handleElicitation: params => (this.childInteractions(params.threadId)?.elicitations ?? fallback).handleElicitation(params),
            handleUserInput: params => (this.childInteractions(params.threadId)?.elicitations ?? fallback).handleUserInput(params),
        };
    }

    /** Called at the router boundary, never for the parent's internal runtime operations. */
    assertSessionMutationAllowed(sessionId: string): void {
        if (this.subagentAssociations.isRestricted(sessionId)) {
            throw RequestError.invalidRequest(undefined, "Subagent sessions do not permit client-initiated mutations");
        }
    }

    captureSessionSetup(sessionId: string): () => void {
        const generation = this.getSessionGeneration(sessionId);
        const check = () => {
            this.assertInstructionsReady(sessionId);
            if (this.sessionIsClosing(sessionId) || this.getSessionGeneration(sessionId) !== generation) {
                throw RequestError.invalidRequest(undefined, "Session closed while setup was queued");
            }
        };
        check();
        return check;
    }

    afterSessionSetupResponse(sessionId: string): Promise<void> {
        const router = this.sessions.get(sessionId)?.subagents;
        if (!(router instanceof StandardSubagentEventRouter) || this.sessionIsClosing(sessionId)) return Promise.resolve();
        this.codexAcpClient.redispatchSessionNotifications(
            sessionId, router.releaseReplay(), () => router.publishReplaySnapshots(),
        );
        return this.codexAcpClient.waitForSessionNotifications(sessionId).catch(error => {
            logger.error("Failed to release child traffic after session setup", error);
        });
    }

    private async interruptStandardChildren(session: SessionState): Promise<void> {
        if (!(session.subagents instanceof StandardSubagentEventRouter)) return;
        const router = session.subagents;
        const turns = router.activeTurns();
        router.cancelInteractions();
        await Promise.all(turns.map(async turn => {
            try {
                const turnId = this.codexAcpClient.appServerClient.runningTurnId(turn.threadId) ?? turn.turnId;
                if (turnId === null) return;
                router.closeWorkRequests(turn.threadId, turnId);
                await this.codexAcpClient.turnInterrupt({threadId: turn.threadId, turnId});
            } catch (error) {
                logger.error(`Failed to interrupt child ${turn.threadId}`, error);
            }
        }));
    }

    private observeSubagentWorkEnd(sessionId: string, event: ServerNotification): void {
        const router = this.sessions.get(sessionId)?.subagents;
        if (router instanceof StandardSubagentEventRouter) router.observeWorkEnd(event);
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        logger.log("Initialize request received");
        this.clientInfo = _params.clientInfo ?? null;
        this.clientCapabilities = _params.clientCapabilities ?? null;
        this.initializeRequest = _params;
        this.capabilities = ClientCapabilities.from(_params.clientCapabilities);
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        this.reportingConnection.reports.compareMeta = this.capabilities.airToolCallContract;
        this.booleanConfigOptionsSupported = clientSupportsBooleanConfigOptions(_params.clientCapabilities);
        this.sessionIndex.configure(_params.clientCapabilities);
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize(_params));
        this.sessionIndex.observe(this.codexAcpClient);
        this.publishFirstAuthStatusAfterResponse();
        const sessionCapabilities: SubagentAwareSessionCapabilities = {
            resume: { },
            list: { },
            close: { },
            delete: { },
            fork: { },
            additionalDirectories: {},
            subagents: {},
            systemPrompt: {},
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
                },
                _meta: {
                    // Presence means "this agent pushes `_auth/status_update`". It
                    // never carries a payload, and the client never asks for one.
                    [AUTH_STATUS_META_KEY]: authStatusCapability(),
                },
            },
            authMethods: getCodexAuthMethods(_params.clientCapabilities),
            _meta: this.initializeExtensionsMeta(1),
        };
    }

    async initializeV2(
        params: acpV2.InitializeRequest,
    ): Promise<acpV2.InitializeResponse> {
        logger.log("Initialize request received", {protocolVersion: params.protocolVersion});
        // Existing capability readers take the v1 shape; v2 fields they read keep their relative path.
        const clientCapabilities = toV1ClientCapabilitiesView(params.capabilities);
        this.clientInfo = params.info;
        this.clientCapabilities = clientCapabilities;
        this.initializeRequest = {clientInfo: params.info};
        this.capabilities = ClientCapabilities.fromV2(clientCapabilities);
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        this.reportingConnection.reports.compareMeta = this.capabilities.airToolCallContract;
        // Boolean config options are baseline on v2, so there is nothing to probe.
        this.booleanConfigOptionsSupported = true;
        this.sessionIndex.configure(clientCapabilities);
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize({clientInfo: params.info}));
        this.sessionIndex.observe(this.codexAcpClient);
        this.publishFirstAuthStatusAfterResponse();
        return {
            protocolVersion: 2,
            info: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            capabilities: {
                auth: {
                    _meta: {
                        // Presence means "this agent pushes `_auth/status_update`".
                        [AUTH_STATUS_META_KEY]: authStatusCapability(),
                    },
                },
                providers: {},
                session: {
                    prompt: {
                        embeddedContext: {},
                        image: {},
                    },
                    mcp: {
                        stdio: {},
                        http: {},
                    },
                    delete: {},
                    additionalDirectories: {},
                    fork: {},
                    systemPrompt: {},
                },
            },
            authMethods: getCodexAuthMethodsV2(clientCapabilities),
            _meta: this.initializeExtensionsMeta(2),
        };
    }

    /**
     * The extension metadata of the initialize response. Only AIR gets the AIR extension, see
     * `docs/air-extensions.md`. v2 has its own terminal, diff and plan updates, so the AIR
     * tool call and plan capabilities are not offered there.
     */
    private initializeExtensionsMeta(protocolVersion: 1 | 2): Record<string, unknown> {
        const airCapabilities = protocolVersion === 1
            ? [
                AIR_SESSION_FAILURE_KEY,
                AIR_DIFF_PATCH_KEY,
                AIR_AGENT_FILE_CHANGE_REPORT_KEY,
                AIR_CUSTOM_INSTRUCTIONS_KEY,
                AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
                AIR_ASYNC_TASKS_KEY,
                AIR_RECOMMENDED_CONFIG_VALUE_KEY,
                AIR_RAW_INPUT_RENDERING_KEY,
                AIR_PLAN_CONTENT_DELTA_KEY,
                AIR_CODEX_HOOKS_KEY,
                ...this.sessionIndex.agentCapabilities(),
            ]
            : [
                AIR_SESSION_FAILURE_KEY,
                AIR_AGENT_FILE_CHANGE_REPORT_KEY,
                AIR_CUSTOM_INSTRUCTIONS_KEY,
                AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
                AIR_ASYNC_TASKS_KEY,
                AIR_RECOMMENDED_CONFIG_VALUE_KEY,
                ...this.sessionIndex.agentCapabilities(),
            ];
        return {
            steering: {
                supported: true,
            },
            ...(this.capabilities.airClient ? {
                [JETBRAINS_META_KEY]: {
                    [AIR_META_KEY]: {
                        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                        [AIR_GOAL_KEY]: {
                            version: GOAL_EXTENSION_VERSION,
                            controlMethod: GOAL_CONTROL_METHOD,
                            actions: [...GOAL_CONTROL_ACTIONS],
                        },
                        [AIR_EXTENSION_CAPABILITIES_KEY]: airCapabilities,
                    },
                },
            } : {}),
        };
    }

    async listHooks(cwd: string): Promise<HooksListEntry> {
        if (this.providerUpdate !== null) await this.waitForProviderUpdate();
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        return await this.runWithProcessCheck(() => listCodexHooks(this.codexAcpClient.appServerClient, cwd));
    }

    async trustHooks(cwd: string, hooks: CodexHookIdentity[]): Promise<{trusted: boolean}> {
        if (this.providerUpdate !== null) await this.waitForProviderUpdate();
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        return {trusted: await this.runWithProcessCheck(() => trustCodexHooks(this.codexAcpClient.appServerClient, cwd, hooks))};
    }

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const methodRequest = { method: method, params: params };
        if (!isExtMethodRequest(methodRequest)) {
            return {};
        }
        switch (methodRequest.method) {
            case "authentication/status":
                return await this.readAuthenticationStatus();
            case "authentication/logout": {
                await this.logout({});
                return {};
            }
            case LEGACY_SET_SESSION_MODEL_METHOD:
                return await this.unstable_setSessionModel(this.parseLegacySetSessionModelParams(methodRequest.params));
            case SESSION_STEERING_METHOD:
                return await this.executeOrQueueSteeringRequest(this.parseSessionSteerParams(methodRequest.params));
            case ASYNC_TASK_STOP_METHOD: {
                if (this.providerUpdate !== null) {
                    await this.waitForProviderUpdate();
                }
                const sessionState = this.sessions.get(methodRequest.params.sessionId);
                if (!sessionState) return {stopped: false};
                // A task of a dead app-server is failed already; stopping it needs no restarted one.
                if (this.recovery !== null && !this.recovery.sessionIsLive(sessionState)) return {stopped: false};
                return {
                    stopped: await this.runWithProcessCheck(
                        () => sessionState.asyncTasks.stop(methodRequest.params.asyncTaskId),
                    ),
                };
            }
            case GOAL_CONTROL_METHOD:
            case LEGACY_GOAL_CONTROL_METHOD: {
                const sessionState = this.sessions.get(methodRequest.params.sessionId);
                if (!sessionState) {
                    throw RequestError.invalidParams(undefined, `Unknown session: ${methodRequest.params.sessionId}`);
                }
                if (this.providerUpdate !== null) {
                    await this.waitForProviderUpdate();
                }
                const sessionReady = this.ensureSessionReady(sessionState);
                if (sessionReady) await sessionReady;
                const sessionGeneration = this.getSessionGeneration(sessionState.sessionId);
                if (methodRequest.params.action === "set") {
                    const objective = methodRequest.params.objective;
                    await this.runWithProcessCheck(() => this.codexAcpClient.setGoal(sessionState.sessionId, objective));
                } else if (methodRequest.params.action === "pause") {
                    const goal = await this.runWithProcessCheck(() => this.codexAcpClient.setGoalStatus(sessionState.sessionId, "paused"));
                    if (this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(goal), false);
                    }
                } else if (methodRequest.params.action === "resume") {
                    let updatedGoal: ThreadGoal | null = null;
                    await this.runWithProcessCheck(() => this.codexAcpClient.resumeGoal(
                        sessionState.sessionId,
                        undefined,
                        (goal) => {
                            updatedGoal = goal;
                        },
                    ));
                    if (updatedGoal !== null && this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(updatedGoal), false);
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

    /**
     * Answers `authentication/status`.
     *
     * An unavailable account read still tells that the agent has a ChatGPT login, because only such a login
     * runs the routing discovery, see {@link isAccountReadUnavailableError}. The answer is then `chat-gpt` with
     * the email of the last known account, or an empty email. A read that failed because the login does not
     * work answers `unauthenticated`, see {@link isAccountReadAuthFailureError}. Another error rejects.
     */
    private async readAuthenticationStatus(): Promise<AuthenticationStatusResponse> {
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        try {
            return await this.runWithProcessCheck(() => this.codexAcpClient.getAuthenticationStatus());
        } catch (error) {
            if (isAccountReadUnavailableError(error)) {
                logger.log("Account read unavailable, so the authentication status uses the last known account", {error: String(error)});
                const account = this.lastReadAccount;
                return {type: "chat-gpt", email: account?.type === "chatgpt" ? account.email ?? "" : ""};
            }
            if (isAccountReadAuthFailureError(error)) {
                logger.log("The account read found that the agent needs a login", {error: String(error)});
                return {type: "unauthenticated"};
            }
            throw error;
        }
    }

    /**
     * Logs in with the default auth request, or throws `auth_required`, when the agent needs a login.
     * Returns the account read that found no login needed, or `null` when there was no read or a login ran.
     * Returns `"unavailable"` when the read failed without an answer about the login, see
     * {@link isAccountReadUnavailableError}. The session open then continues: a missing login fails the
     * resume or the first turn with the real error.
     */
    async checkAuthorization(): Promise<KnownAccount> {
        const requirement = await this.readAccountOrUnavailable(() => this.codexAcpClient.readAuthRequirement());
        if (requirement === "unavailable") return "unavailable";
        logger.log("Auth requirement checked", {authRequired: requirement.required});
        if (requirement.required) {
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
            return null;
        }
        return requirement.account;
    }

    async getOrCreateSession(
        request: WithAcpMcpServers<acp.NewSessionRequest> | WithAcpMcpServers<acp.ResumeSessionRequest>,
    ): Promise<[SessionId, LegacySessionModelState, SessionModeState]> {
        try {
            return await this.tryCreateSession(request);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            await this.handleError(error);
            throw e;
        }
    }

    async handleError(e: Error){
        if (requiresLogout(e)) {
            await this.runWithProcessCheck(() => this.codexAcpClient.logout());
            await this.refreshAuthState(null);
            throw RequestError.internalError(`${(e.message)}\n\nYou have been logged out. Please try again.`);
        }
    }

    private async withSystemPromptUpdate<T>(
        request: {sessionId: string; systemPrompt?: unknown; _meta?: unknown},
        action: () => Promise<T>,
    ): Promise<T> {
        this.assertInstructionsReady(request.sessionId);
        if (!changesSystemPrompt(request, this.sessions.get(request.sessionId)?.instructions)) return action();
        const sessionId = request.sessionId;
        if (this.isSessionBusy(sessionId) || this.activePrompts.has(sessionId)
            || this.pendingTurnStarts.has(sessionId) || this.turnStartQueueTail.get(sessionId)?.settled === false) {
            throw RequestError.invalidParams(undefined, "Cannot change systemPrompt while session work is in progress; retry when idle");
        }
        this.instructionUpdates.add(sessionId);
        try {
            return await action();
        } finally {
            this.instructionUpdates.delete(sessionId);
        }
    }

    private restoreExistingSessionTracker(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (this.instructionUpdates.has(sessionId) && session && !this.sessionIsClosing(sessionId)) {
            this.startCodexTurnTracker(sessionId, Promise.resolve(session));
        } else {
            this.codexAcpClient.discardSessionSubscription(sessionId);
        }
    }

    private assertInstructionsReady(sessionId: string): void {
        if (this.instructionUpdates.has(sessionId)) {
            throw RequestError.invalidRequest(undefined, "Session instructions are being updated; retry after session setup");
        }
    }

    private async beginSessionOpen(sessionId: string): Promise<number> {
        const generation = this.getSessionGeneration(sessionId);
        const begin = () => {
            if (this.sessionIsClosing(sessionId)) throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
            if (this.getSessionGeneration(sessionId) !== generation) {
                throw RequestError.invalidRequest(`Session ${sessionId} closed while setup was queued`);
            }
            const subagents = this.sessions.get(sessionId)?.subagents;
            if (subagents instanceof StandardSubagentEventRouter) subagents.pauseForSetup();
            this.sessionOpenGenerations.set(sessionId, generation);
        };
        // An admitted child event finishes before replay changes its publication boundary.
        if (this.usesStandardSubagents()) await this.codexAcpClient.enqueueSessionTransition(sessionId, begin);
        else begin();
        return generation;
    }

    /**
     * Whether a fork that failed before its session was installed may unsubscribe its thread. A client can find
     * the new thread in the session list and load it meanwhile; that open owns the subscription then.
     */
    private canReleaseFailedFork(threadId: string): boolean {
        return !this.sessionOpenGenerations.has(threadId) && !this.sessions.has(threadId);
    }

    /**
     * Unsubscribes the thread of a fork that failed before its session was installed, see
     * {@link canReleaseFailedFork}. The close fence keeps a new open of the thread out until the unsubscribe and
     * the handler cleanup are done, as for {@link cleanupStaleSessionOpen}.
     */
    private async releaseFailedFork(threadId: string): Promise<void> {
        if (!this.canReleaseFailedFork(threadId)) return;
        this.beginSessionCloseFence(threadId);
        try {
            // A dead app-server holds nothing to close.
            if (this.recovery === null || this.recovery.isReady()) {
                await this.codexAcpClient.closeSession(threadId);
            }
        } catch (err) {
            logger.error(`Failed to close the thread of a failed fork ${threadId}`, err);
        } finally {
            this.endSessionCloseFence(threadId);
        }
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
                // A dead app-server holds nothing to close.
                if (this.recovery === null || this.recovery.isReady()) {
                    await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(sessionId));
                }
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

    private bumpSessionGeneration(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId) + 1;
        this.sessionGenerations.set(sessionId, generation);
        return generation;
    }

    async tryCreateSession(
        request: WithAcpMcpServers<acp.NewSessionRequest>
            | WithAcpMcpServers<acp.ResumeSessionRequest>
            | WithAcpMcpServers<acp.ForkSessionRequest>,
        operation: "new" | "resume" | "fork" = "sessionId" in request ? "resume" : "new",
    ): Promise<[SessionId, LegacySessionModelState, SessionModeState]> {
        clientSystemPromptText(request.systemPrompt);
        const existingSessionRequest = request as WithAcpMcpServers<acp.ResumeSessionRequest> | WithAcpMcpServers<acp.ForkSessionRequest>;
        const previousInstructions = "sessionId" in request ? this.sessions.get(request.sessionId)?.instructions : undefined;
        const requestedSessionGeneration = operation === "resume"
            ? await this.beginSessionOpen(existingSessionRequest.sessionId)
            : null;
        const knownAccount = await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const readMcpServerStartupVersion = () => requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;
        let mcpServerStartupVersion = readMcpServerStartupVersion();

        let sessionMetadata: SessionMetadata;
        let resumeSubscribed = false;
        // The app-server that loads the thread, read in the closure that loads it. A crash after the load makes the
        // session stale, see AppServerRecovery.
        let openGeneration = this.recovery?.generation ?? 0;
        // Registered before `thread/resume` is even sent, so a goal turn Codex auto-starts on the
        // resumed thread can't slip in before a handler exists; see `startCodexTurnTracker`.
        let settleTrackerReady: ((state: SessionState | null) => void) | null = null;
        if (operation === "resume") {
            const resumeRequest = request as WithAcpMcpServers<acp.ResumeSessionRequest>;
            logger.log(`Resume existing session: ${resumeRequest.sessionId}...`);
            const [trackerReady, resolveTrackerReady] = createDeferred<SessionState | null>();
            settleTrackerReady = resolveTrackerReady;
            this.startCodexTurnTracker(resumeRequest.sessionId, trackerReady);
            try {
                const pendingResume = this.recovery?.settleResume(resumeRequest.sessionId);
                if (pendingResume) await pendingResume;
                sessionMetadata = await this.runWithProcessCheck(() => {
                    openGeneration = this.recovery?.generation ?? 0;
                    mcpServerStartupVersion = readMcpServerStartupVersion();
                    return this.codexAcpClient.resumeSession(resumeRequest, () => {
                        resumeSubscribed = true;
                    }, previousInstructions);
                });
            } catch (err) {
                settleTrackerReady?.(!resumeSubscribed && this.instructionUpdates.has(resumeRequest.sessionId)
                    ? this.sessions.get(resumeRequest.sessionId) ?? null : null);
                if (resumeSubscribed && requestedSessionGeneration !== null) {
                    await this.cleanupStaleSessionOpen(resumeRequest.sessionId, requestedSessionGeneration);
                } else {
                    // A rejected instruction change keeps the original session's event delivery.
                    this.restoreExistingSessionTracker(resumeRequest.sessionId);
                }
                throw err;
            }
        } else if (operation === "fork") {
            const forkRequest = request as WithAcpMcpServers<acp.ForkSessionRequest>;
            logger.log(`Fork existing session: ${forkRequest.sessionId}...`);
            sessionMetadata = await this.runWithProcessCheck(() => {
                openGeneration = this.recovery?.generation ?? 0;
                mcpServerStartupVersion = readMcpServerStartupVersion();
                return this.codexAcpClient.forkSession(
                    forkRequest,
                    threadId => this.releaseFailedFork(threadId),
                    threadId => this.sessionIndex.forkCreated(forkRequest.sessionId, threadId),
                    previousInstructions,
                );
            });
        } else {
            logger.log(`Create new session...`);
            sessionMetadata = await this.runWithProcessCheck(() => {
                openGeneration = this.recovery?.generation ?? 0;
                mcpServerStartupVersion = readMcpServerStartupVersion();
                return this.codexAcpClient.newSession(request as WithAcpMcpServers<acp.NewSessionRequest>);
            });
        }

        const {sessionId, currentModelId, models} = sessionMetadata;
        const authProvider = sessionMetadata.modelProvider ?? this.codexAcpClient.getModelProvider();
        let authState: ActiveAuthState;
        try {
            authState = await this.getAuthStateForProvider(authProvider, knownAccount);
        } catch (err) {
            settleTrackerReady?.(null);
            if (resumeSubscribed && requestedSessionGeneration !== null) {
                await this.cleanupStaleSessionOpen(sessionId, requestedSessionGeneration);
            } else if (operation === "fork") {
                // The fork stays subscribed after `thread/fork`; without a session nothing would unsubscribe it.
                await this.releaseFailedFork(sessionId);
            }
            throw err;
        }
        const sessionGeneration = requestedSessionGeneration ?? await this.beginSessionOpen(sessionId);
        if (!this.sessionOpenCanInstall(sessionId, sessionGeneration)) {
            settleTrackerReady?.(null);
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
            interruptTurnId: null,
            codexReportedRunningTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            promptTokenUsage: null,
            threadHasHistory: operation !== "new",
            ...(sessionMetadata.instructions ? {instructions: sessionMetadata.instructions} : {}),
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
            clientCapabilities: this.capabilities,
            goalRevision: 0,
            sessionTitle: null,
            sessionTitleSource: operation === "resume" ? "unknown" : "unset",
            subagents: this.createSubagentRouter(sessionId),
            asyncTasks: this.createAsyncTasks(sessionId),
            compactions: new CodexSessionCompactions(),
            toolCallReports: this.reportingConnection.reports,
            openToolCalls: new CodexSessionToolCalls(),
        };
        sessionState.titleGen = new TitleGenerator(
            this.codexAcpClient.appServerClient,
            sessionId,
            sessionState.cwd,
            () => sessionState.sessionTitleSource,
            this.sessionIndex.titleWriter(sessionId),
        );
        this.installSessionState(sessionState);
        AcpV2Connection.of(this.connection)?.restoreForegroundState(sessionId, sessionMetadata.threadStatus?.type === "active");
        this.recovery?.markLoaded(sessionState, openGeneration);
        if (settleTrackerReady) {
            settleTrackerReady(sessionState);
        } else {
            this.startCodexTurnTracker(sessionId, Promise.resolve(sessionState));
        }
        resumeSubscribed = false;

        const canPublishSessionUpdates = operation !== "fork";
        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            // A fork publishes no startup report, so nothing waits for the rest of the startup.
            const startupWait = this.mcpSessionStartup.begin(sessionId, requestedMcpServers, mcpServerStartupVersion, {
                publish: canPublishSessionUpdates,
                awaitTimeoutMs: parseMcpStartupAwaitTimeoutMs(request._meta),
                skippedServers: sessionMetadata.skippedMcpServers,
            });
            if (startupWait !== null) {
                try {
                    await startupWait;
                } catch (err) {
                    // The session is installed already. A failed wait closes it, so the client never gets a half-open session.
                    await this.closeSession({sessionId}).catch(closeError => {
                        logger.error(`Failed to close session ${sessionId} after a failed MCP startup wait`, closeError);
                    });
                    throw err;
                }
            }
        }

        if (this.protocolVersion === 2) {
            await this.initializeAvailableCommandsV2(sessionState, sessionGeneration);
        } else if (canPublishSessionUpdates) {
            this.publishAvailableCommandsAsync(sessionState, sessionGeneration);
        }
        if (operation === "resume") {
            this.publishCurrentGoalAsync(sessionState, sessionGeneration);
            this.publishAsyncTasksAsync(sessionState, sessionGeneration);
        }
        const sessionModelState: LegacySessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState =
            sessionState.agentMode.toSessionModeState(sessionState.clientCapabilities.airClient);

        return [sessionId, sessionModelState, sessionModeState];
    }

    /**
     * Reads the account of `authProvider` and pushes the auth status. `knownAccount` is an account read that
     * the caller already has.
     *
     * When the read is unavailable, the adapter pushes no status, so the client keeps the last status.
     * A `none` status would be false here: AIR shows a login request for it. The session keeps the
     * account of the last read.
     */
    private async getAuthStateForProvider(
        authProvider: string | null,
        knownAccount: KnownAccount = null,
    ): Promise<ActiveAuthState> {
        if (!this.authProviderUsesOpenAiAccount(authProvider)) {
            await this.publishAuthStatus(authProvider, null);
            return {
                account: null,
                authConfigured: true,
            };
        }
        const accountResponse = knownAccount === "unavailable"
            ? null
            : knownAccount ?? await this.readAccountIfAvailable();
        if (accountResponse === null) {
            logger.log("No account read, so the auth status stays as it was");
            return {
                account: this.lastReadAccount,
                authConfigured: true,
            };
        }
        this.lastReadAccount = accountResponse.account;
        await this.publishAuthStatus(authProvider, accountResponse.account);
        return {
            account: accountResponse.account,
            authConfigured: accountResponse.account !== null || !accountResponse.requiresOpenaiAuth,
        };
    }

    /** Reads the account, or returns `null` when the read failed without an answer about the login. */
    private async readAccountIfAvailable(): Promise<GetAccountResponse | null> {
        const response = await this.readAccountOrUnavailable(() => this.codexAcpClient.getAccount());
        return response === "unavailable" ? null : response;
    }

    /**
     * Runs an account read, or returns `"unavailable"` when it failed without an answer about the login,
     * see {@link isAccountReadUnavailableError}. Another error rejects.
     */
    private async readAccountOrUnavailable<T>(read: () => Promise<T>): Promise<T | "unavailable"> {
        try {
            return await this.runWithProcessCheck(read);
        } catch (error) {
            if (!isAccountReadUnavailableError(error)) throw error;
            logger.log("Account read unavailable, the login state is unknown", {error: String(error)});
            return "unavailable";
        }
    }

    /**
     * Applies the account read of a load that answered before the read ended.
     *
     * The answer applies only while the load is the current open of the session, and while no auth status
     * was set after the read started. A close or a new load of the session makes the answer old.
     * A newer status, from any source, also makes it old. An old answer changes nothing.
     *
     * - A read that found no login needed sets the account of the session and pushes the auth status.
     * - A read that found that the agent needs a login (`auth_required`), or that failed because the login
     *   does not work ({@link isAccountReadAuthFailureError}, for example a revoked token), clears the account
     *   and pushes the `none` status at once, with no second read. The client then shows a login request,
     *   as it does for an `auth_required` error of the load.
     * - A read that failed because another client logged in or out reads the account again and pushes it.
     * - An unavailable read changes nothing.
     * - Any other failure is logged as an error and pushes nothing. It tells nothing sure about the login,
     *   so the client keeps the last status.
     */
    private applyLateAccountRead(
        sessionState: SessionState,
        authorization: Promise<KnownAccount>,
        authStatusVersionAtStart: number,
    ): void {
        const sessionIsCurrent = () => this.sessions.get(sessionState.sessionId) === sessionState;
        const answerIsCurrent = () => {
            if (!sessionIsCurrent()) {
                logger.log("A late account read ended after the load closed, so it changes nothing", {sessionId: sessionState.sessionId});
                return false;
            }
            if (this.authStatusVersion !== authStatusVersionAtStart) {
                logger.log("A late account read ended after a newer auth status, so it changes nothing", {sessionId: sessionState.sessionId});
                return false;
            }
            return true;
        };
        void authorization.then(
            async knownAccount => {
                if (knownAccount === "unavailable" || !answerIsCurrent()) return;
                const authState = await this.getAuthStateForProvider(sessionState.authProvider, knownAccount);
                if (!sessionIsCurrent()) return;
                sessionState.account = authState.account;
                sessionState.authConfigured = authState.authConfigured;
            },
            async error => {
                if (!answerIsCurrent()) return;
                if (isAuthRequiredError(error) || isAccountReadAuthFailureError(error)) {
                    logger.log("A late account read found that the agent needs a login", {error: String(error)});
                    this.lastReadAccount = null;
                    sessionState.account = null;
                    sessionState.authConfigured = false;
                    await this.publishAuthStatus(sessionState.authProvider, null);
                    return;
                }
                if (isAccountReadAccountChangedError(error)) {
                    logger.log("The account changed while a late account read ran, so the adapter reads it again");
                    await this.publishAuthStatusRead();
                    return;
                }
                logger.error("A late account read failed, so the auth status stays as it was", error);
            },
        ).catch(error => logger.error("Failed to apply a late account read", error));
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

    private createAsyncTasks(sessionId: string): CodexBackgroundTerminalTasks {
        return new CodexBackgroundTerminalTasks(
            clientSupportsAirCapability(this.clientCapabilities, AIR_ASYNC_TASKS_KEY),
            sessionId,
            this.codexAcpClient.appServerClient,
            new ACPSessionConnection(this.connection, sessionId),
        );
    }

    private installSessionState(sessionState: SessionState): void {
        this.sessions.get(sessionState.sessionId)?.asyncTasks.clear();
        this.sessions.set(sessionState.sessionId, sessionState);
    }

    /**
     * Installs a baseline session-scoped subscription, so a Codex-initiated turn starting before
     * any `session/prompt` has run still updates `codexReportedRunningTurnId`, gets its
     * `running`/`idle` states, and renders its items. `prompt()`'s own
     * `subscribeToSessionEvents` call permanently replaces this dispatch
     * (`CodexSubagentSubscriptions.subscribe` keeps a single `current` subscription per session)
     * the first time a prompt runs, and that subscription's own leftover-rendering path takes over
     * from then on; this baseline handler only ever dispatches for a session no prompt has
     * subscribed to yet, so it cannot double-render. It answers approval/elicitation requests
     * exactly like app-server's own default for a thread with no handler registered, so no real
     * prompt has yet run to answer.
     *
     * `ready` lets a resume/load caller register this *before* `thread/resume`/`thread/load` is
     * even sent, so a goal turn Codex auto-starts on the resumed thread within a few ms of the
     * response can't slip in before a handler exists (nothing else buffers dropped notifications).
     * The per-session notification queue (`enqueueSessionNotification`) serializes handler calls,
     * so awaiting `ready` in the first event holds every later event for this session in order;
     * nothing is dropped or reordered. `ready` resolves to the real `SessionState` once install
     * finishes (or `null` on a failed/superseded open, in which case events are silently ignored).
     */
    private startCodexTurnTracker(sessionId: string, ready: Promise<SessionState | null>): void {
        let baselineEventHandler: CodexEventHandler | null = null;
        void this.codexAcpClient.subscribeToSessionEvents(
            sessionId,
            async (event) => {
                const sessionState = await ready;
                if (!sessionState) return;
                if (!baselineEventHandler) {
                    baselineEventHandler = new CodexEventHandler(
                        this.connection,
                        sessionState,
                        clientSupportsTypedSessionFailures(this.clientCapabilities),
                        this.sessionFailureEpoch,
                        sessionState.subagents,
                        (accountUpdated) => this.handleAccountUpdated(accountUpdated),
                        false,
                        clientSupportsCompaction(this.clientCapabilities),
                        clientSupportsNotices(this.clientCapabilities),
                    );
                }
                await this.trackCodexForegroundWork(sessionState, event);
                await this.trackSteerLanding(sessionState, event);
                this.handleSkillsChanged(sessionState, event);
                // Codex-started turns carry no `userMessage` item; `handleSessionScopedNotification`
                // already drops that item type, so nothing is synthesized here.
                await baselineEventHandler.handleSessionScopedNotification(event);
                await this.trackCodexTurnCompletion(sessionState, event, baselineEventHandler);
            },
            this.routeChildApprovals(DENY_ALL_APPROVALS),
            this.routeChildElicitations(DENY_ALL_ELICITATIONS),
            this.supportsNativeSubagents(),
            () => {},
            async childThreadId => {
                const state = await ready;
                return state?.subagents instanceof StandardSubagentEventRouter
                    ? state.subagents.waitForMaterializedSession(childThreadId) : null;
            },
            async (childId, itemId, request, turnId) => {
                const state = await ready;
                return state?.subagents.withUserAction?.(childId, itemId, request, turnId) ?? request();
            },
            event => this.observeSubagentWorkEnd(sessionId, event),
        );
    }

    /**
     * Whether Codex reports a turn currently running on the thread, from `turn/started`/
     * `turn/completed` -- independent of whether a `session/prompt` started it.
     */
    private isCodexTurnRunning(sessionId: string): boolean {
        return this.sessions.get(sessionId)?.codexReportedRunningTurnId != null;
    }

    /**
     * Whether the session is busy enough that a settled permission request should resume
     * `running` rather than leave the client at `requires_action`: either a Codex turn is
     * running, or a v2 prompt is in flight (covers the gap between two Codex turns of the same
     * prompt, e.g. the plan/implementation approval, where no turn has started yet).
     */
    private isSessionBusy(sessionId: string): boolean {
        return this.isCodexTurnRunning(sessionId) || this.v2PromptsInFlight.has(sessionId);
    }

    /**
     * Tracks runtime work before prompt insertion, including parallel items that can still progress.
     */
    private async trackCodexForegroundWork(sessionState: SessionState, event: ServerNotification): Promise<void> {
        const v2 = AcpV2Connection.of(this.connection);
        // Active with no waits means Codex is running, even when no item is currently streaming.
        // Nonempty flags only count pending requests; they do not prove aggregate blocking.
        if (event.method === "thread/status/changed" && event.params.threadId === sessionState.sessionId
            && event.params.status.type === "active" && event.params.status.activeFlags.length === 0) {
            await this.reportCodexTurnState(sessionState.sessionId, {state: "running"});
        }
        if ((event.method === "item/started" || event.method === "item/completed")
            && event.params.threadId === sessionState.sessionId
            && event.params.turnId === sessionState.codexReportedRunningTurnId
            && event.params.item.type !== "userMessage") {
            if (event.method === "item/started") {
                await v2?.startForegroundItem(sessionState.sessionId, event.params.item.id);
            } else {
                await v2?.completeForegroundItem(sessionState.sessionId, event.params.item.id);
            }
        }
        if ((event.method === "item/agentMessage/delta" || event.method === "item/reasoning/textDelta"
            || event.method === "item/reasoning/summaryTextDelta")
            && event.params.threadId === sessionState.sessionId
            && event.params.turnId === sessionState.codexReportedRunningTurnId) {
            await v2?.startForegroundItem(sessionState.sessionId, event.params.itemId);
        }
        if (event.method !== "turn/started" || event.params.threadId !== sessionState.sessionId) {
            return;
        }
        sessionState.codexReportedRunningTurnId = event.params.turn.id;
        await this.reportCodexTurnState(sessionState.sessionId, {state: "running"});
    }

    /**
     * The other half of `trackCodexForegroundWork`: sends exactly one `idle` for a turn no v2 prompt
     * owns, after the notification's own content has already been handled so `idle`
     * stays the last thing sent for the turn.
     */
    private async trackCodexTurnCompletion(
        sessionState: SessionState,
        event: ServerNotification,
        eventHandler: CodexEventHandler,
    ): Promise<void> {
        if (event.method !== "turn/completed" || event.params.threadId !== sessionState.sessionId) {
            return;
        }
        if (sessionState.codexReportedRunningTurnId === event.params.turn.id) {
            sessionState.codexReportedRunningTurnId = null;
        }
        const failure = eventHandler.getTurnFailure(event.params.turn);
        if (this.protocolVersion === 2 && failure !== null && !this.v2PromptsInFlight.has(sessionState.sessionId)) {
            await this.finishOutstandingToolCalls(sessionState);
        }
        await this.reportCodexTurnState(sessionState.sessionId, toV2IdleState({
            stopReason: stopReasonForUnownedTurn(event.params.turn.status),
        }, failure));
    }

    /**
     * Prompt-owned workflows may span several runtime turns; their caller reports the final idle.
     * Runtime starts report running independently of insertion. v1 has no foreground-state updates.
     */
    private async reportCodexTurnState(sessionId: string, state: acpV2.StateUpdate): Promise<void> {
        if (this.v2PromptsInFlight.has(sessionId) && state.state === "idle") {
            return;
        }
        const session = new ACPSessionConnection(this.connection, sessionId);
        if (session.protocolVersion !== 2) {
            return;
        }
        try {
            await session.updateState(state);
        } catch (error) {
            logger.error(`Failed to send the '${state.state}' state for session ${sessionId}`, error);
        }
    }

    /**
     * Fails every tool call this session's tracker still has open (a provider restart's
     * dead app-server process never sent `item/completed` for it). No-op if nothing is open, e.g.
     * every item on the cut-off turn already completed before the restart. Runs on v1 and v2
     * alike -- `ACPSessionConnection.update()` renders each accordingly.
     */
    private async finishOutstandingToolCalls(session: SessionState): Promise<void> {
        const updates = session.openToolCalls.finishOutstanding();
        if (updates.length === 0) {
            return;
        }
        const connection = new ACPSessionConnection(this.connection, session.sessionId);
        for (const update of updates) {
            await connection.update(update);
        }
    }

    /**
     * Matches an injected steer's `userMessage` landing against `pendingSteerLandings`, and
     * drops any entries a completed turn never delivered (Codex dropped the steered input
     * silently, so nothing is shown for it). Called from every session-scoped subscription
     * (the baseline one and each prompt's own), so it works whether the steer lands inside a
     * v2-prompt-owned turn or an unowned one.
     */
    private async trackSteerLanding(sessionState: SessionState, event: ServerNotification): Promise<void> {
        if (event.method === "turn/completed" && event.params.threadId === sessionState.sessionId) {
            for (const [clientUserMessageId, entry] of this.pendingSteerLandings) {
                if (entry.sessionId === sessionState.sessionId) {
                    this.pendingSteerLandings.delete(clientUserMessageId);
                }
            }
            return;
        }
        for (const [clientUserMessageId, entry] of this.pendingSteerLandings) {
            if (entry.sessionId === sessionState.sessionId
                && isInsertedUserMessage(event, sessionState.sessionId, clientUserMessageId)) {
                this.pendingSteerLandings.delete(clientUserMessageId);
                await this.emitLiveSteerUserMessage(sessionState.sessionId, clientUserMessageId, entry.prompt);
                return;
            }
        }
    }

    /**
     * Shows a landed steer as a live-only `user_message` (v2 only; the steering response itself
     * carries no `messageId`, per user decision).
     */
    private async emitLiveSteerUserMessage(sessionId: string, messageId: string, prompt: acp.ContentBlock[]): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        if (session.protocolVersion !== 2) {
            return;
        }
        try {
            for (const block of prompt) {
                await session.update(createUserMessageChunk(block, messageId));
            }
        } catch (error) {
            logger.error(`Failed to send the steered user message for session ${sessionId}`, error);
        }
    }

    private getAuthProviderForAuthenticateRequest(request: acp.AuthenticateRequest): string | null {
        if (isCodexAuthRequest(request) && request.methodId === "gateway") {
            return "custom-gateway";
        }
        return null;
    }

    async loadSession(params: acp.LoadSessionRequest): Promise<LegacyLoadSessionResponse> {
        return this.recovery === null
            ? await this.loadSessionOnce(params)
            : await this.recovery.trackOpen(params.sessionId, () => this.loadSessionOnce(params));
    }

    private async loadSessionOnce(params: acp.LoadSessionRequest): Promise<LegacyLoadSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.waitForProviderUpdate();
        }
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        logger.log("Loading session...", {sessionId: params.sessionId});
        const {sessionId, modelState, modeState} = await this.loadSessionAndReplayHistory(params);

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

    /**
     * Shared by v1 `session/load` and v2 `session/resume` with `replayFrom: {type: "start"}`:
     * reattach, replay retained history as ordinary `session/update`s, then answer.
     */
    private async loadSessionAndReplayHistory(
        params: WithAcpMcpServers<acp.LoadSessionRequest>,
    ): Promise<{
        sessionId: SessionId;
        modelState: LegacySessionModelState;
        modeState: SessionModeState;
    }> {
        return this.withSystemPromptUpdate(params, () => this.loadSessionAndReplayHistoryOnce(params));
    }

    private async loadSessionAndReplayHistoryOnce(
        params: WithAcpMcpServers<acp.LoadSessionRequest>,
    ): Promise<{sessionId: SessionId; modelState: LegacySessionModelState; modeState: SessionModeState}> {
        // Captured before the load installs a fresh SessionState: a title
        // generation started by an earlier turn on this session belongs to the
        // state being replaced, and has to settle before we answer.
        const previousTitleGen = this.sessions.get(params.sessionId)?.titleGen;
        const {
            sessionId,
            modelState,
            modeState,
            thread,
            history,
            sessionState,
            settleTrackerReady,
        } = await this.getOrCreateSessionWithHistory(params);

        try {
            try {
                await this.streamThreadHistory(sessionId, thread, history);
            } finally {
                // Only after replay is fully streamed does the baseline tracker start dispatching
                // live events, so a live goal-turn frame can never race ahead of history.
                settleTrackerReady(sessionState);
            }
        } catch (err) {
            // A close during the load already closed the session.
            if (err instanceof SessionClosedDuringLoadError) {
                throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
            }
            // The history pages are read after the session is installed, so a failed read closes the
            // session again. The client never gets a half-open session.
            await this.closeSession({sessionId}).catch(closeError => {
                logger.error(`Failed to close session ${sessionId} after a failed history read`, closeError);
            });
            throw this.recovery?.mapError(err) ?? err;
        }
        await this.getSessionState(sessionId).asyncTasks.reconcile();
        // A load response means "the replay is complete"; a late rename echo
        // from a still-running title generation would arrive after it.
        await previousTitleGen?.waitForIdle(TITLE_GENERATION_SETTLE_TIMEOUT_MS);

        return {sessionId, modelState, modeState};
    }

    async resumeSession(params: WithAcpMcpServers<acp.ResumeSessionRequest>): Promise<LegacyResumeSessionResponse> {
        return this.withSystemPromptUpdate(params, async () => this.recovery === null
            ? await this.resumeSessionOnce(params)
            : await this.recovery.trackOpen(params.sessionId, () => this.resumeSessionOnce(params)));
    }

    private async resumeSessionOnce(params: WithAcpMcpServers<acp.ResumeSessionRequest>): Promise<LegacyResumeSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.waitForProviderUpdate();
        }
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
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

    async resumeSessionV2(params: acpV2.ResumeSessionRequest): Promise<acpV2.ResumeSessionResponse> {
        const {replayFrom, systemPrompt, ...rest} = params;
        const request = {...rest, systemPrompt: toV1SystemPrompt(systemPrompt)};
        if (replayFrom == null) {
            await this.resumeSession(request);
            await this.snapshotForegroundState(params.sessionId);
            return this.createSessionSetupResponseV2(this.getSessionState(params.sessionId));
        }
        if (replayFrom.type !== "start") {
            throw RequestError.invalidParams(undefined, `Unsupported replayFrom type: ${replayFrom.type}`);
        }
        const {sessionId} = await this.loadSessionAndReplayHistory(request);
        await this.snapshotForegroundState(sessionId);
        return this.createSessionSetupResponseV2(this.getSessionState(sessionId));
    }

    private async snapshotForegroundState(sessionId: string): Promise<void> {
        // Drain live events released by setup/replay before taking the ordered snapshot.
        await this.codexAcpClient.waitForSessionNotifications(sessionId);
        this.getSessionState(sessionId);
        await AcpV2Connection.of(this.connection)!.snapshotForegroundState(sessionId);
    }

    async forkSession(params: WithAcpMcpServers<acp.ForkSessionRequest>): Promise<acp.ForkSessionResponse> {
        clientSystemPromptText(params.systemPrompt);
        this.assertInstructionsReady(params.sessionId);
        return this.sessionIndex.forking(params.sessionId, () => this.createFork(params));
    }

    private async createFork(params: WithAcpMcpServers<acp.ForkSessionRequest>): Promise<acp.ForkSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.waitForProviderUpdate();
        }
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
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

    async forkSessionV2(params: acpV2.ForkSessionRequest): Promise<acpV2.ForkSessionResponse> {
        const {systemPrompt, ...rest} = params;
        const request = {...rest, systemPrompt: toV1SystemPrompt(systemPrompt)};
        const {sessionId} = await this.forkSession(request);
        return {
            sessionId,
            ...this.createSessionSetupResponseV2(this.getSessionState(sessionId)),
        };
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        logger.log("Listing sessions...", {cwd: params.cwd, cursor: params.cursor});
        if (this.sessionIndex.enabled) {
            const response = await this.sessionIndex.list(params);
            return {...response, sessions: response.sessions.filter(session => !this.subagentAssociations.isRestricted(session.sessionId))};
        }
        await this.checkAuthorization();
        const response = await this.runWithProcessCheck(() => this.codexAcpClient.listSessions(params));
        return {
            ...response,
            sessions: response.sessions.filter(session => !this.subagentAssociations.isRestricted(session.sessionId)).map((session) => {
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

        try {
            // Same as `session/cancel`: drop every v2 prompt still queued for this session first.
            this.cancelQueuedV2Prompts(params.sessionId);
            if (sessionState) {
                await this.interruptSessionTurn(sessionState, "Close", true);
                if (sessionState.subagents instanceof StandardSubagentEventRouter) {
                    await sessionState.subagents.finishOutstanding("disconnected");
                }
                sessionState.asyncTasks.clear();
            } else {
                logger.log("Close request received for unknown local session", {sessionId: params.sessionId});
            }

            const activePrompt = this.activePrompts.get(params.sessionId);
            if (activePrompt) {
                activePrompt.requestClose();
                await activePrompt.completion;
            }

            if (this.recovery === null || this.recovery.isReady() && (!sessionState || this.recovery.sessionIsLive(sessionState))) {
                await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(params.sessionId));
            } else {
                // The thread is not loaded in a running app-server: nothing to close there, and no restart for it.
                logger.log("Session closed without an app-server call: its app-server is gone", {sessionId: params.sessionId});
            }
            await this.reportCodexTurnState(params.sessionId, {state: "idle", stopReason: "cancelled"});
            logger.log("Session closed", {sessionId: params.sessionId});
        } finally {
            if (this.getSessionGeneration(params.sessionId) === closeGeneration) {
                this.sessions.delete(params.sessionId);
                if (!this.v2PromptsInFlight.has(params.sessionId)) {
                    AcpV2Connection.of(this.connection)?.forgetSession(params.sessionId);
                }
                this.mcpSessionStartup.close(params.sessionId);
                this.codexAcpClient.appServerClient.mcpStartup.forgetThread(params.sessionId);
                this.pendingTurnStarts.delete(params.sessionId);
                this.activePrompts.delete(params.sessionId);
                this.turnStartQueueTail.delete(params.sessionId);
                this.queuedV2PromptCancellers.delete(params.sessionId);
                this.steeringQueues.delete(params.sessionId);
                if (sessionState) {
                    this.availableCommands.cancelPendingSkillsPublish(sessionState);
                }
            }
            this.endSessionCloseFence(params.sessionId);
        }

        return {};
    }

    async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
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

            if (this.sessionIndex.enabled) {
                await this.sessionIndex.deleteThread(sessionId, shouldCloseLocalSession);
            } else {
                await this.runWithProcessCheck(() => this.codexAcpClient.deleteSession(sessionId));
            }
            logger.log("Session deleted", {sessionId});
        } finally {
            this.endSessionCloseFence(sessionId);
        }

        return {};
    }

    private hasLocalSession(sessionId: string): boolean {
        return this.sessions.has(sessionId)
            || this.mcpSessionStartup.isPending(sessionId)
            || this.pendingTurnStarts.has(sessionId)
            || this.activePrompts.has(sessionId)
            || this.hasPendingSessionOpen(sessionId)
            || this.sessionIsClosing(sessionId);
    }

    private hasPendingSessionOpen(sessionId: string): boolean {
        return this.sessionOpenGenerations.get(sessionId) === this.getSessionGeneration(sessionId);
    }

    async newSession(
        params: WithAcpMcpServers<acp.NewSessionRequest>,
    ): Promise<LegacyNewSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.waitForProviderUpdate();
        }
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
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

    async newSessionV2(params: acpV2.NewSessionRequest): Promise<acpV2.NewSessionResponse> {
        const {systemPrompt, ...rest} = params;
        const request = {...rest, systemPrompt: toV1SystemPrompt(systemPrompt)};
        const {sessionId} = await this.newSession(request);
        return {
            sessionId,
            ...this.createSessionSetupResponseV2(this.getSessionState(sessionId)),
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
        requestId?: acp.JsonRpcId,
    ): Promise<acp.AuthenticateResponse> {
        logger.log("Authenticate request received");
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        const elicitationRequester = this.createUrlElicitationRequester(requestId);
        const isAuthenticated = await this.runWithProcessCheck(() => this.codexAcpClient.authenticate(_params, elicitationRequester));
        if (!isAuthenticated) {
            logger.log("Authenticate request failed");
            throw RequestError.authRequired({methodId: _params.methodId}, "Sign-in did not complete");
        }
        await this.refreshAuthState(this.getAuthProviderForAuthenticateRequest(_params));
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
        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        await this.runWithProcessCheck(() => this.codexAcpClient.logout());
        await this.refreshAuthState(null);
        logger.log("Logout request completed");
    }

    /** v2 `auth/login`: same params as v1 `authenticate`, only the method name changed. */
    async authenticateV2(
        params: acpV2.LoginAuthRequest,
        requestId?: acpV2.JsonRpcId,
    ): Promise<acpV2.LoginAuthResponse> {
        return await this.authenticate(params, requestId);
    }

    /** v2 `auth/logout`: same params as v1 `logout`, only the method name changed. */
    async logoutV2(params: acpV2.LogoutAuthRequest): Promise<acpV2.LogoutAuthResponse> {
        await this.logout(params);
        return {};
    }

    listProviders(_params: acp.ListProvidersRequest): acp.ListProvidersResponse {
        return { providers: this.codexAcpClient.listProviders() };
    }

    async setProvider(params: acp.SetProviderRequest): Promise<acp.SetProviderResponse> {
        const request = ++this.providerRequests;
        // A provider restart can replace the client while the models are listed, so the routing goes to the current one.
        const gatewayConfig = await this.codexAcpClient.prepareProvider(params);
        if (this.appliedProviderRequest > request) {
            logger.log("providers/set dropped: a newer provider request was applied while the models were listed");
            return { };
        }
        this.appliedProviderRequest = request;
        this.codexAcpClient.setProvider(gatewayConfig);
        // The restarted app-server takes the listing too and does not list the models again.
        await this.enqueueProviderUpdate((client) => client.setProvider(gatewayConfig));
        return { };
    }

    async disableProvider(params: acp.DisableProviderRequest): Promise<acp.DisableProviderResponse> {
        this.codexAcpClient.disableProvider(params);
        if (params.providerId !== OPENAI_PROVIDER_ID) {
            return { };
        }
        this.appliedProviderRequest = ++this.providerRequests;
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
            for (const session of this.sessions.values()) {
                session.asyncTasks.prepareForAppServerReplacement();
            }
            await this.finishAllAsyncTasks("stopped", "before the provider restart");
            const replacement = await this.restartCodexClient();
            // Captured before the swap: draining its per-session queues below (after the process
            // it wraps has already exited) is how a turn left running on the old client gets
            // closed out, since the old process's EOF drops the notification and no
            // `turn/completed` ever arrives for it.
            const previousClient = this.codexAcpClient;
            for (const session of this.sessions.values()) {
                if (session.subagents instanceof StandardSubagentEventRouter) await session.subagents.finishOutstanding("disconnected");
            }
            apply(replacement);
            if (this.initializeRequest === null) {
                throw new Error("Cannot restart Codex app-server before ACP initialization");
            }
            await replacement.initialize(this.initializeRequest);
            this.codexAcpClient = replacement;
            this.sessionIndex.observe(replacement);
            this.availableCommands = this.createAvailableCommands(replacement);

            const resumeErrors: unknown[] = [];
            this.recovery?.completeReplacement(replacement);
            const replacementGeneration = this.recovery?.generation ?? 0;
            for (const session of this.sessions.values()) {
                // v2 only: a turn still running when the old process was killed never gets its
                // `turn/completed` -- the old process's EOF just drops the notification -- which
                // would otherwise leave the session wedged at `running` forever (an R13 MUST
                // violation) and `isSessionBusy` stuck true. Drain the old client's queue first so
                // an already-buffered `turn/completed` still clears this normally; only a turn
                // genuinely orphaned by the restart gets force-closed. No-op on v1 (no state
                // channel) and while a v2 prompt is in flight for the session (its own `idle`
                // closes the state). This must happen before this session's tracker is registered
                // and it's resumed: Codex can auto-start a continuation turn within a few ms of
                // `thread/resume`'s response, and that turn's own `running` would otherwise be
                // mistaken for the cut-off one and cancelled instead.
                await previousClient.waitForSessionNotifications(session.sessionId);
                if (session.subagents instanceof StandardSubagentEventRouter) {
                    session.subagents = this.createSubagentRouter(session.sessionId);
                }
                if (session.codexReportedRunningTurnId !== null) {
                    session.codexReportedRunningTurnId = null;
                    // the dead process's EOF drops `item/completed` for anything still open on
                    // the cut-off turn (v1 + v2), leaving the client with a spinner forever. Fail
                    // those tool calls -- and end their terminals -- before the turn's own
                    // idle/cancelled close-out below.
                    await this.finishOutstandingToolCalls(session);
                    await this.reportCodexTurnState(session.sessionId, {state: "idle", stopReason: "cancelled"});
                }

                session.asyncTasks.setAppServer(replacement.appServerClient);
                session.titleGen?.rebindAppServer(replacement.appServerClient);
                if (replacement.appServerClient.connectionLoss.lost) {
                    // The new app-server died: the next use of each session resumes it in the restarted one.
                    break;
                }
                // Registered before `resumeSession`, so a goal turn Codex auto-starts within a
                // few ms of `thread/resume`'s response can't slip past an empty subscription
                // registry on the new client (10(f1) `startCodexTurnTracker`).
                const [trackerReady, settleTrackerReady] = createDeferred<SessionState | null>();
                this.startCodexTurnTracker(session.sessionId, trackerReady);
                try {
                    const request = {
                        sessionId: session.sessionId,
                        cwd: session.cwd,
                        additionalDirectories: session.additionalDirectories,
                        mcpServers: session.mcpServers ?? [],
                    };
                    let resumed: SessionMetadata | null = null;
                    const resume = async (onSubscribed?: () => void) => {
                        resumed = onSubscribed === undefined
                            ? await replacement.resumeSession(request, undefined, session.instructions)
                            : await replacement.resumeSession(request, onSubscribed, session.instructions);
                        return resumed;
                    };
                    await (this.recovery?.resumeForReplacement(session, replacementGeneration, replacement, resume) ?? resume());
                    session.authProvider = replacement.getModelProvider();
                    session.asyncTasks.refresh();
                    settleTrackerReady(session);
                    logger.log("Resumed session after provider restart", {sessionId: session.sessionId});
                    if (resumed) await this.applyResumedModels(session, replacement, resumed);
                } catch (error) {
                    settleTrackerReady(null);
                    if (error instanceof ThreadRefusedError || error instanceof SessionReplacedError
                        || error instanceof UnpersistedSessionLostError) {
                        // A refused session stays not live and its next use reports the refusal; a session that closed
                        // or opened again meanwhile needs no resume; a session without messages was never persisted,
                        // so no app-server can resume it, and its next use reports the loss. None of them fails the
                        // provider update, which applied to the agent and to every session that can go on.
                        logger.log("Session not resumed after provider restart", {sessionId: session.sessionId, reason: String(error)});
                        continue;
                    }
                    resumeErrors.push(this.recovery?.mapError(error, replacement) ?? error);
                    logger.error(`Failed to resume session ${session.sessionId} after provider restart`, error);
                }
            }
            if (this.recovery !== null && !this.recovery.isReady(replacementGeneration)) {
                // The new app-server died: report its exit, so requests that waited for the update restart it.
                throw this.recovery.errorForGeneration(replacementGeneration);
            }
            if (resumeErrors.length > 0) {
                throw new AggregateError(resumeErrors, `Failed to resume ${resumeErrors.length} session(s) after provider restart`);
            }
        });
        this.providerUpdate = update;
        this.recovery?.settleReplacement(update);
        try {
            await update;
        } catch (error) {
            throw this.recovery?.mapError(error) ?? error;
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
        const process = state.connection.process;
        state.stderrProcess = process;
        process.stderr.addListener("data", (data: Buffer) => {
            // Late output of an old app-server does not belong in the crash report of the new one.
            if (state.connection.process !== process) return;
            state.stderr = (state.stderr + data.toString()).slice(-2 * 1024);
        });
    }

    private async restartCodexClient(): Promise<CodexAcpClient> {
        if (this.recovery === null) {
            throw new Error("Codex process state is unavailable");
        }
        return await this.recovery.beginReplacement();
    }

    /**
     * Waits for the provider update in flight. When its app-server died, the request goes on: the failure belongs to
     * the `providers/set` request, and the request restarts the app-server itself. Any other failure fails it, as before.
     */
    private async waitForProviderUpdate(): Promise<void> {
        try {
            await this.providerUpdate;
        } catch (error) {
            const mapped = this.recovery?.mapError(error) ?? error;
            if (!(mapped instanceof RequestError && mapped.code === CODEX_PROCESS_EXITED_ERROR_CODE)) throw error;
            logger.log("A provider update failed because its app-server died; the request goes on", {error: String(error)});
        }
    }

    /**
     * Starts the app-server again when it crashed. The entry points of user requests call it, see `AppServerRecovery`.
     * Returns `undefined` when the app-server runs, so callers add no `await` on the normal path:
     * `const appServer = this.ensureAppServer(); if (appServer) await appServer;`.
     */
    private ensureAppServer(): Promise<void> | undefined {
        return this.recovery?.ensureRunning();
    }

    /** Resumes the thread of `sessionState` again when it was loaded in an app-server that died; see {@link ensureAppServer}. */
    private ensureSessionReady(sessionState: SessionState): Promise<void> | undefined {
        return this.recovery?.ensureSessionReady(sessionState);
    }

    /** Runs an operation of a prompt on the app-server of `generation`, never on a restarted one. */
    private runOnAppServer<T>(generation: number, client: CodexAcpClient, operation: () => Promise<T>): Promise<T> {
        try {
            this.recovery?.throwIfLost(generation);
        } catch (error) {
            return Promise.reject(error);
        }
        return this.runWithProcessCheck(operation, client);
    }

    private createRecovery(): AppServerRecovery<SessionState> | null {
        const state = this.codexProcessState;
        if (state === null) return null;
        const supervisor = state.supervisor ?? new CodexAppServerSupervisor(state);
        state.supervisor = supervisor;
        return new AppServerRecovery<SessionState>({
            supervisor,
            currentClient: () => this.codexAcpClient,
            createClient: (connection) => {
                this.captureStderr();
                return this.codexAcpClient.withAppServer(new CodexAppServerClient(connection.connection));
            },
            handshake: (client) => this.initializeRequest !== null && this.codexAcpClient.initialized
                ? client.initialize(this.initializeRequest)
                : null,
            install: (client) => this.installCodexClient(client),
            crashed: () => {
                // Every session takes its tasks now, before any await, so a task that a restarted app-server starts
                // meanwhile is not failed with the old ones.
                for (const session of this.sessions.values()) {
                    if (session.subagents instanceof StandardSubagentEventRouter) {
                        session.subagentTransition = session.subagents.finishOutstanding("disconnected")
                            .catch(error => logger.error("Failed to report child observability loss", error));
                        session.subagents = this.createSubagentRouter(session.sessionId);
                    }
                    session.asyncTasks.finishAll("failed").catch(error => {
                        logger.error("Failed to finish background terminal tasks after the Codex process exited", error);
                    });
                }
            },
            resumeSession: async (session, client, onSubscribed) => {
                const metadata = await client.resumeSession({
                    sessionId: session.sessionId,
                    cwd: session.cwd,
                    additionalDirectories: session.additionalDirectories,
                    mcpServers: session.mcpServers ?? [],
                }, onSubscribed, session.instructions);
                // A session the provider restart failed to resume gets the models of the routing here.
                await this.applyResumedModels(session, client, metadata);
                return {collaborationMode: metadata.collaborationMode};
            },
            applyCollaborationMode: (session, client) =>
                client.setCollaborationMode(session.sessionId, session.collaborationMode, session.currentModelId),
            collaborationMode: (session) => session.collaborationMode,
            resumed: (session) => session.asyncTasks.refresh(),
            sessionLifetime: (session) => this.getSessionGeneration(session.sessionId),
            isCurrent: (session, lifetime) => this.sessions.get(session.sessionId) === session
                && this.getSessionGeneration(session.sessionId) === lifetime
                && !this.sessionIsClosing(session.sessionId),
            installedSession: (sessionId) => this.sessions.get(sessionId),
        }, recoveryLimitsFromEnv());
    }

    /** Makes `client`, of a restarted app-server, the client of the agent and of every session. */
    private installCodexClient(client: CodexAcpClient): void {
        // A `providers/set` can have changed the routing of the old client while the restart ran.
        client.adoptRoutingFrom(this.codexAcpClient);
        this.codexAcpClient = client;
        // The session index watches the thread notifications of the app-server that runs now.
        this.sessionIndex.observe(client);
        this.availableCommands = this.createAvailableCommands(client);
        for (const session of this.sessions.values()) {
            session.asyncTasks.setAppServer(client.appServerClient);
            session.titleGen?.rebindAppServer(client.appServerClient);
        }
    }

    /** Returns whether the auth state was read (and thus the auth status pushed). */
    private async refreshSessionsAuthState(authProvider: string | null): Promise<boolean> {
        if (this.sessions.size === 0) return false;

        const sessionsToRefresh = [...this.sessions.values()]
            .filter(sessionState => this.authProvidersMatch(sessionState.authProvider, authProvider));
        if (sessionsToRefresh.length === 0) return false;

        const authState = await this.getAuthStateForProvider(authProvider);
        for (const sessionState of sessionsToRefresh) {
            sessionState.account = authState.account;
            sessionState.authConfigured = authState.authConfigured;
        }
        return true;
    }

    /**
     * Refreshes the sessions of a provider and makes sure the connection-level
     * `authStatus` is pushed even when no session matched (the empty-screen
     * login case). Reuses the session refresh read; never adds a second one.
     */
    private async refreshAuthState(authProvider: string | null): Promise<void> {
        const refreshed = await this.refreshSessionsAuthState(authProvider);
        if (refreshed) return;
        try {
            // Only the push matters here: there is no session for the auth state to land in.
            await this.getAuthStateForProvider(authProvider ?? this.codexAcpClient.getModelProvider());
        } catch (error) {
            logger.log("Failed to refresh auth status", {error: String(error)});
        }
    }

    /**
     * Schedules the connection's first `_auth/status_update`: one account read,
     * pushed whatever it says, including `none`.
     *
     * The push must not overtake the `initialize` response. The JSON-RPC layer
     * writes that response in the microtask that resolves {@link initialize}, so
     * the read starts from a check-phase callback, which always runs after it.
     * `initialize` itself never waits for the read.
     *
     * "Unconditional" costs nothing extra here: nothing has been pushed yet on
     * this connection, so {@link setAuthStatus} cannot suppress this one.
     */
    private publishFirstAuthStatusAfterResponse(): void {
        setImmediate(() => void this.publishAuthStatusRead());
    }

    /**
     * Reads the agent-owned identity and pushes it.
     *
     * Never rejects: an unreadable source means "nothing to report", not an
     * error. The client then keeps showing the last pushed value, or "not
     * reported" when there was none.
     *
     * A read that failed because the login does not work, for example a revoked
     * token, is an answer: it pushes the `none` status, see
     * {@link isAccountReadAuthFailureError}.
     */
    private async publishAuthStatusRead(): Promise<void> {
        let authStatus: AuthStatus;
        try {
            authStatus = await this.readAgentAuthIdentity();
        } catch (error) {
            if (isAccountReadAuthFailureError(error)) {
                logger.log("The account read found that the agent needs a login", {error: String(error)});
                this.lastReadAccount = null;
                await this.setAuthStatus(fromAccount(null));
                return;
            }
            logger.log("Cannot determine auth status", {error: String(error)});
            return;
        }
        await this.setAuthStatus(authStatus);
    }

    /**
     * Builds the agent-owned auth identity. Routing the client configured
     * through the ACP `providers/*` API is invisible here: the reported state
     * is what the agent itself is logged in with. `gateway` stays reserved for
     * agent-owned gateway state — the `gateway` auth method, or a provider the
     * user configured in Codex's own config.
     */
    private async readAgentAuthIdentity(): Promise<AuthStatus> {
        const authGatewayName = this.codexAcpClient.getAuthGatewayProviderName();
        if (authGatewayName !== null) {
            return gatewayStatus(authGatewayName);
        }
        const modelProvider = await this.runWithProcessCheck(() => this.codexAcpClient.getAgentConfiguredModelProvider());
        if (!this.authProviderUsesOpenAiAccount(modelProvider)) {
            return agentConfiguredProviderStatus(modelProvider);
        }
        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        this.lastReadAccount = accountResponse.account;
        return fromAccount(accountResponse.account);
    }

    /**
     * Pushes `_auth/status_update` for the freshly read account of a provider.
     * Agent-owned gateway authentication wins; a client-driven provider
     * override is ignored and the agent-owned login is reported instead.
     */
    private async publishAuthStatus(
        authProvider: string | null,
        account: Account | null,
    ): Promise<void> {
        const authGatewayName = this.codexAcpClient.getAuthGatewayProviderName();
        if (authGatewayName !== null) {
            await this.setAuthStatus(gatewayStatus(authGatewayName));
            return;
        }
        if (this.authProviderUsesOpenAiAccount(authProvider)) {
            await this.setAuthStatus(fromAccount(account));
            return;
        }
        if (this.codexAcpClient.isClientConfiguredProvider(authProvider)) {
            // The session routes through client-configured providers; the agent-owned
            // login is a separate question, so read it instead of reporting the
            // override. A failed read means "nothing to report" — it must never
            // take the session create down with it.
            await this.publishAuthStatusRead();
            return;
        }
        await this.setAuthStatus(agentConfiguredProviderStatus(authProvider));
    }

    /**
     * Handles the app-server `account/updated` push: the free freshness channel
     * for logins and logouts happening outside this connection.
     */
    handleAccountUpdated(notification: AccountUpdatedNotification): void {
        void this.applyAccountUpdated(notification);
    }

    /**
     * `account/updated` describes the Codex account only. It must never
     * overwrite an agent-owned gateway status, which no account event can
     * invalidate; only a gateway logout or a provider change does.
     */
    private async applyAccountUpdated(notification: AccountUpdatedNotification): Promise<void> {
        this.lastReadAccount = accountFromUpdated(notification, this.lastReadAccount);
        try {
            if (this.codexAcpClient.getAuthGatewayProviderName() !== null) {
                return;
            }
            if (this.currentAuthStatus === null) {
                // Nothing pushed yet, so the account event alone cannot tell whether
                // the agent routes through its own gateway config: read the full state.
                await this.publishAuthStatusRead();
                return;
            }
            if (this.currentAuthStatus.kind === "gateway") {
                return;
            }
            await this.setAuthStatus(fromAccountUpdated(notification, this.currentAuthStatus));
        } catch (error) {
            logger.log("Failed to apply account update to auth status", {error: String(error)});
        }
    }

    /**
     * Stores `next` and pushes `_auth/status_update`.
     *
     * A push goes out only when the payload changed. The identity is read on
     * many occasions — `initialize`, each session create, each `account/updated`
     * — and almost all of them see the login already reported.
     * Clients replace their whole state on each update and tolerate duplicates,
     * so a repeat is harmless, but it is pure noise all the same.
     *
     * The first push of a connection always goes out: nothing was reported yet,
     * so no payload can equal it.
     */
    private async setAuthStatus(next: AuthStatus): Promise<void> {
        this.authStatusVersion += 1;
        if (sameAuthStatus(this.currentAuthStatus, next)) {
            return;
        }
        this.currentAuthStatus = next;
        try {
            await this.connection.notify(AUTH_STATUS_UPDATE_METHOD, {authStatus: next});
        } catch (error) {
            logger.log("Failed to send auth status update", {error: String(error)});
        }
    }

    async setSessionMode(
        _params: acp.SetSessionModeRequest,
    ): Promise<acp.SetSessionModeResponse> {
        this.assertInstructionsReady(_params.sessionId);
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
        this.assertInstructionsReady(params.sessionId);
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

    async setSessionConfigOptionV2(
        params: acpV2.SetSessionConfigOptionRequest,
    ): Promise<acpV2.SetSessionConfigOptionResponse> {
        const response = await this.setSessionConfigOption(toV1SetSessionConfigOptionRequest(params));
        return {configOptions: toV2ConfigOptions(response.configOptions)};
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
        if (this.recovery !== null && !this.recovery.sessionIsLive(sessionState)) {
            // The thread is not loaded in a running app-server. Its resume applies the mode, see AppServerRecovery.
            sessionState.collaborationMode = mode;
            return;
        }
        await this.runWithProcessCheck(() => this.codexAcpClient.setCollaborationMode(sessionState.sessionId, mode, sessionState.currentModelId));
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

    /**
     * Takes the models of a session that a provider restart resumed: the provider decides which models there are.
     * The session keeps its model when it can, the way a resumed thread keeps its own; see `createModelId`.
     */
    private async applyResumedModels(sessionState: SessionState, client: CodexAcpClient, resumed: SessionMetadata): Promise<void> {
        const configOptions = JSON.stringify(this.createSessionConfigOptions(sessionState));
        const {model, effort} = ModelId.fromString(sessionState.currentModelId);
        sessionState.availableModels = resumed.models;
        sessionState.currentModelId = client.createModelId(resumed.models, model, effort as ReasoningEffort).toString();
        const currentModel = this.findCurrentModel(resumed.models, sessionState.currentModelId);
        sessionState.supportedReasoningEfforts = currentModel?.supportedReasoningEfforts ?? [];
        sessionState.supportedInputModalities = currentModel?.inputModalities ?? ["text", "image"];
        sessionState.currentModelSupportsFast = modelSupportsFast(currentModel);
        if (JSON.stringify(this.createSessionConfigOptions(sessionState)) !== configOptions) {
            await new ACPSessionConnection(this.connection, sessionState.sessionId).update({
                sessionUpdate: "config_option_update",
                configOptions: this.createSessionConfigOptions(sessionState),
            });
        }
    }

    private applyModelAndEffort(sessionState: SessionState, model: Model, effort: ReasoningEffort): void {
        sessionState.currentModelId = ModelId.fromComponents(model, effort).toString();
        sessionState.supportedReasoningEfforts = model.supportedReasoningEfforts;
        sessionState.supportedInputModalities = model.inputModalities;
        sessionState.currentModelSupportsFast = modelSupportsFast(model);
    }

    async unstable_setSessionModel(params: LegacySetSessionModelRequest): Promise<LegacySetSessionModelResponse> {
        this.assertInstructionsReady(params.sessionId);
        logger.log("Set session model requested", {
            sessionId: params.sessionId,
            modelId: params.modelId
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        const {model: requestedModelName, effort: requestedEffort} = ModelId.fromString(params.modelId);

        const appServer = this.ensureAppServer();
        if (appServer) await appServer;
        const models = await this.runWithProcessCheck(() => this.codexAcpClient.fetchAvailableModels());
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
        this.assertInstructionsReady(params.sessionId);
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

        // Minted fresh for every steer (both protocol versions), passed to Codex as
        // `TurnSteerParams.clientUserMessageId`/`TurnStartParams.clientUserMessageId`. It is a
        // Codex-side param only; on v2 it doubles as the `messageId` of the live `user_message`
        // shown once the steer lands (the steering response itself carries no id).
        const clientUserMessageId = randomUUID();
        const turnId = await this.getSteerableTurnId(sessionState);
        if (turnId) {
            const injected = await this.injectSteerIntoActiveTurn(params, turnId, sessionState, clientUserMessageId);
            if (injected) {
                logger.log("Steering session injected", {sessionId: params.sessionId, turnId});
                return {outcome: "injected"};
            }
        }
        return await this.startNewTurnFromSteering(params, clientUserMessageId);
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
        clientUserMessageId: string,
    ): Promise<boolean> {
        // Registered before the call goes out (not after `steerTurn` resolves), so the landing
        // matcher catches a userMessage that arrives immediately after acceptance.
        this.pendingSteerLandings.set(clientUserMessageId, {sessionId: params.sessionId, prompt: params.prompt});
        try {
            await this.runWithProcessCheck(() => this.codexAcpClient.steerTurn({
                threadId: params.sessionId,
                turnId,
                prompt: params.prompt,
                clientUserMessageId,
            }));
            return true;
        } catch (err) {
            this.pendingSteerLandings.delete(clientUserMessageId);
            await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            const turnStillActive = sessionState.currentTurnId !== null
                && codexRunningTurnId(sessionState, sessionState.currentTurnId) === turnId;
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
    private async startNewTurnFromSteering(
        params: SessionSteerRequest,
        clientUserMessageId: string,
    ): Promise<SessionSteeringResponse> {
        await this.startNewTurnFromExternalPrompt(params, "Steering", undefined, {
            clientUserMessageId,
            onInserted: async () => {
                await this.emitLiveSteerUserMessage(params.sessionId, clientUserMessageId, params.prompt);
            },
            onSyntheticInserted: async () => {},
        });
        return {outcome: "startedNewTurn"};
    }

    private async startNewTurnFromExternalPrompt(
        params: acp.PromptRequest,
        source: string,
        canStart: () => Promise<boolean> = async () => true,
        insertion?: UserMessageInsertion,
    ): Promise<boolean> {
        // Takes this session's place in the shared turn-start FIFO before anything else runs, so
        // no other starter can begin between this check and the turn actually starting. This
        // hands the reservation to `prompt()` below rather than letting it self-acquire one, so
        // it releases only once `prompt()` truly finishes (not when this function's own steer
        // promise resolves early, on the "a turn was started" success path).
        const reservation = this.acquireTurnStartReservation(params.sessionId);
        if (reservation.needsWait) {
            await reservation.wait;
        }
        if (this.sessionIsClosing(params.sessionId)) {
            reservation.release();
            throw RequestError.invalidRequest(`Session ${params.sessionId} is closing`);
        }
        if (!await canStart()) {
            reservation.release();
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
            }, insertion, reservation);
            void promptDone.finally(() => reservation.release());
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
            return codexRunningTurnId(sessionState, sessionState.currentTurnId);
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
        const useRecommendedValue = clientSupportsAirCapability(
            this.clientCapabilities,
            AIR_RECOMMENDED_CONFIG_VALUE_KEY,
        );
        const currentModel = this.findCurrentModel(sessionState.availableModels, sessionState.currentModelId);
        const recommendedModelId = useRecommendedValue
            ? sessionState.availableModels.find(model => model.isDefault)?.id
            : undefined;
        const configOptions = [
            sessionState.agentMode.toConfigOption(sessionState.clientCapabilities.airClient),
            createCollaborationModeConfigOption(sessionState.collaborationMode),
        ];
        // A gateway that lists none of the Codex models leaves no model to offer, so there is no model option at all.
        if (sessionState.availableModels.length > 0) {
            configOptions.push(createModelConfigOption(sessionState.availableModels, currentModelId.model, recommendedModelId));
        }
        if (sessionState.supportedReasoningEfforts.length > 0) {
            configOptions.push(
                createReasoningEffortConfigOption(
                    sessionState.supportedReasoningEfforts,
                    currentModelId.effort,
                    useRecommendedValue ? currentModel?.defaultReasoningEffort : undefined,
                ),
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

    /** Initial v2 configuration and commands for new, resumed, and forked sessions. */
    private createSessionSetupResponseV2(sessionState: SessionState): {
        configOptions?: Array<acpV2.SessionConfigOption>;
        availableCommands?: Array<acpV2.AvailableCommand>;
    } {
        const {configOptions} = this.createSessionConfigOptionsResponse(sessionState);
        const commands = this.availableCommands.initialCommands(sessionState);
        return {
            ...(configOptions ? {configOptions: toV2ConfigOptions(configOptions)} : {}),
            ...(commands.length > 0 ? {availableCommands: toV2AvailableCommands(commands)} : {}),
        };
    }

    private isSessionConfigEnabled(): boolean {
        // Temporarily disabled for JB IDEs 2026.1 due to issues in session_config (LLM-28118)
        return !isJetBrains2026_1Client(this.clientInfo);
    }

    private publishAvailableCommandsAsync(sessionState: SessionState, sessionGeneration: number): void {
        void this.publishAvailableCommands(sessionState, sessionGeneration);
    }

    private async initializeAvailableCommandsV2(sessionState: SessionState, sessionGeneration: number): Promise<void> {
        await this.availableCommands.initialize(
            sessionState,
            () => this.sessionPublishIsCurrent(sessionState, sessionGeneration),
        );
        if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
            throw RequestError.invalidRequest(undefined, `Session ${sessionState.sessionId} was closed or replaced during setup`);
        }
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

    private publishAsyncTasksAsync(sessionState: SessionState, sessionGeneration: number): void {
        if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)) return;
        sessionState.asyncTasks.refresh();
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

    /**
     * Lists the skills of a session again when Codex reports that its skill files changed.
     *
     * The notification carries no thread, so app-server sends it to every subscribed session, and each one lists
     * its own cwds. A skill that appears while a session is open - a new file, a new symlink, a changed link
     * target - becomes a command right away instead of only after the next turn.
     */
    private handleSkillsChanged(sessionState: SessionState, event: ServerNotification): void {
        if (event.method !== "skills/changed") {
            return;
        }
        const sessionGeneration = this.getSessionGeneration(sessionState.sessionId);
        this.availableCommands.publishOnSkillsChanged(
            sessionState,
            () => this.sessionPublishIsCurrent(sessionState, sessionGeneration),
        );
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
        const update = goalSessionInfoUpdate(snapshot, sessionState.clientCapabilities.airClient);
        if (update === null) return;
        await new ACPSessionConnection(this.connection, sessionState.sessionId).update(update);
    }

    private findCurrentModel(models: Model[], currentModelId: string): Model | undefined {
        const modelId = ModelId.fromString(currentModelId);
        return models.find(m => m.id === modelId.model);
    }

    private createModelState(availableModels: Model[], selectedModelId: string): LegacySessionModelState {
        const allowedModels = availableModels
            .flatMap((model) =>
                model.supportedReasoningEfforts.map((effort) => ({
                    modelId: ModelId.fromComponents(model, effort.reasoningEffort).toString(),
                    name: `${formatModelDisplayName(model.displayName)} (${effort.reasoningEffort})`,
                    description: `${model.description} ${effort.description}`,
                }))
            );
        return {
            availableModels: allowedModels,
            currentModelId: selectedModelId,
        }
    }

    private async getOrCreateSessionWithHistory(
        request: WithAcpMcpServers<acp.LoadSessionRequest>
    ): Promise<{
        sessionId: SessionId;
        modelState: LegacySessionModelState;
        modeState: SessionModeState;
        thread: Thread;
        history: AsyncIterable<ThreadItemEntry[]>;
        sessionState: SessionState;
        // Settles the baseline tracker's `ready` gate; resolve after `streamThreadHistory` so a
        // live goal-turn frame Codex fires right after resume/load never races ahead of replay.
        settleTrackerReady: (state: SessionState | null) => void;
    }> {
        clientSystemPromptText(request.systemPrompt);
        const previousInstructions = this.sessions.get(request.sessionId)?.instructions;
        const requestedSessionGeneration = await this.beginSessionOpen(request.sessionId);
        const loadStartedAt = performance.now();
        const graceLeftMs = () => ACCOUNT_READ_LOAD_GRACE_MS - (performance.now() - loadStartedAt);
        const authStatusVersionAtStart = this.authStatusVersion;
        // The account read can wait for a network call of the app-server, so it runs while
        // `thread/resume` reads the rollout. A login with the default auth request can change
        // the provider of the resume, so the login keeps the order.
        const authorization = this.defaultAuthRequest
            ? Promise.resolve(await this.checkAuthorization())
            : this.checkAuthorization();
        // The load awaits the result below. This stops an unhandled rejection while `thread/resume` runs.
        authorization.catch(() => {});
        const requestedMcpServers = request.mcpServers ?? [];
        const readMcpServerStartupVersion = () => requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;
        let mcpServerStartupVersion = readMcpServerStartupVersion();

        logger.log(`Load existing session: ${request.sessionId}...`);
        let subscribed = false;
        // Registered before `thread/resume` is even sent; see `startCodexTurnTracker`.
        const [trackerReady, settleTrackerReady] = createDeferred<SessionState | null>();
        this.startCodexTurnTracker(request.sessionId, trackerReady);
        let sessionMetadata: SessionMetadataWithThread;
        let knownAccount: KnownAccount | "pending";
        // The app-server that loads the thread, read in the closure that loads it. A crash after the load makes the
        // session stale, see AppServerRecovery.
        let openGeneration = this.recovery?.generation ?? 0;
        try {
            try {
                const pendingResume = this.recovery?.settleResume(request.sessionId);
                if (pendingResume) await pendingResume;
                sessionMetadata = await this.runWithProcessCheck(() => {
                    openGeneration = this.recovery?.generation ?? 0;
                    mcpServerStartupVersion = readMcpServerStartupVersion();
                    return this.codexAcpClient.loadSession(request, () => {
                        subscribed = true;
                    }, previousInstructions);
                });
            } catch (err) {
                // An auth error that is known within the grace time comes first, as it did when the check ran
                // before `thread/resume`. A read that is still pending does not hold back the resume error.
                await settledWithin(authorization, graceLeftMs());
                throw err;
            }
            knownAccount = await settledWithin(authorization, graceLeftMs());
        } catch (err) {
            settleTrackerReady(!subscribed && this.instructionUpdates.has(request.sessionId)
                ? this.sessions.get(request.sessionId) ?? null : null);
            if (subscribed) {
                await this.cleanupStaleSessionOpen(request.sessionId, requestedSessionGeneration);
            } else {
                // A rejected instruction change keeps the original session's event delivery.
                this.restoreExistingSessionTracker(request.sessionId);
            }
            throw err;
        }

        const {sessionId, currentModelId, models, thread} = sessionMetadata;
        const authProvider = sessionMetadata.modelProvider ?? this.codexAcpClient.getModelProvider();
        let authState: ActiveAuthState;
        try {
            authState = await this.getAuthStateForProvider(authProvider, knownAccount === "pending" ? "unavailable" : knownAccount);
        } catch (err) {
            settleTrackerReady(null);
            if (subscribed) {
                await this.cleanupStaleSessionOpen(request.sessionId, requestedSessionGeneration);
            }
            throw err;
        }
        if (!this.sessionOpenCanInstall(sessionId, requestedSessionGeneration)) {
            settleTrackerReady(null);
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
            interruptTurnId: null,
            codexReportedRunningTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            promptTokenUsage: null,
            threadHasHistory: true,
            ...(sessionMetadata.instructions ? {instructions: sessionMetadata.instructions} : {}),
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
            clientCapabilities: this.capabilities,
            goalRevision: 0,
            sessionTitle: null,
            sessionTitleSource: "unset",
            subagents: this.createSubagentRouter(sessionId, true),
            asyncTasks: this.createAsyncTasks(sessionId),
            compactions: new CodexSessionCompactions(),
            toolCallReports: this.reportingConnection.reports,
            openToolCalls: new CodexSessionToolCalls(),
        };
        sessionState.titleGen = new TitleGenerator(
            this.codexAcpClient.appServerClient,
            sessionId,
            sessionState.cwd,
            () => sessionState.sessionTitleSource,
            this.sessionIndex.titleWriter(sessionId),
        );
        this.installSessionState(sessionState);
        AcpV2Connection.of(this.connection)?.restoreForegroundState(sessionId, thread.status.type === "active");
        this.recovery?.markLoaded(sessionState, openGeneration);
        if (knownAccount === "pending") {
            this.applyLateAccountRead(sessionState, authorization, authStatusVersionAtStart);
        }
        subscribed = false;

        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            this.mcpSessionStartup.begin(sessionId, requestedMcpServers, mcpServerStartupVersion, {
                publish: true,
                skippedServers: sessionMetadata.skippedMcpServers,
            });
        }

        if (this.protocolVersion === 2) {
            await this.initializeAvailableCommandsV2(sessionState, requestedSessionGeneration);
        } else {
            await this.publishAvailableCommands(sessionState, requestedSessionGeneration);
        }
        await this.publishCurrentGoalBestEffort(sessionState, requestedSessionGeneration, true);
        const sessionModelState: LegacySessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState =
            sessionState.agentMode.toSessionModeState(sessionState.clientCapabilities.airClient);

        return {
            sessionId: sessionId,
            modelState: sessionModelState,
            modeState: sessionModeState,
            thread: thread,
            history: sessionMetadata.history,
            sessionState: sessionState,
            settleTrackerReady: settleTrackerReady,
        };
    }

    /**
     * Sends the history of a loaded session one page of items at a time. The
     * adapter keeps only the current page, not the whole history.
     */
    private async streamThreadHistory(
        sessionId: string,
        thread: Thread,
        history: AsyncIterable<ThreadItemEntry[]>,
    ): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        const sessionState = this.getSessionState(sessionId);
        const generation = this.getSessionGeneration(sessionId);
        const isOpen = () => this.getSessionGeneration(sessionId) === generation;
        const pages = history[Symbol.asyncIterator]();
        const first = await pages.next();
        const firstPage = first.done ? [] : first.value;
        // The first user message of the first page names the session.
        await this.publishThreadHistoryTitle(session, sessionState, thread, firstPage.map(entry => entry.item));
        const entryPages = pagesStartingWith(firstPage, pages);
        // Hiding the `/review` reviewer prompt is a v2-only change (user decision): v1 keeps
        // showing it, as it always has.
        const itemPages = untilSessionClose(
            this.protocolVersion === 2 ? withoutReviewerPrompts(entryPages) : itemsOfEntries(entryPages),
            isOpen,
        );
        if (this.usesStandardSubagents()) {
            await this.streamStandardThreadHistory(sessionId, standardHistoryItems(itemPages), sessionState, new Set([sessionId]), isOpen);
            return;
        }
        if (this.supportsNativeSubagents()) {
            await this.streamNativeThreadHistory(
                sessionId,
                itemPages,
                sessionState,
                new Set([sessionId]),
                new Set(),
                isOpen,
            );
            return;
        }
        const startedReplayMessages = new Set<string>();
        for await (const items of itemPages) {
            for (const item of items) {
                if (!isOpen()) throw new SessionClosedDuringLoadError();
                for (const update of await this.createHistoryUpdates(item, sessionState)) {
                    if (this.protocolVersion === 2) {
                        await this.sendReplayMessageStart(session, update, startedReplayMessages);
                    }
                    await session.update(update);
                }
            }
        }
    }

    /**
     * On v2, replay reconstructing a message from its beginning via chunks MUST first send a
     * whole-message update with `content: []` for the same id, clearing any content the client
     * already holds for it (`session-setup.mdx`). No-op for chunks with no messageId: those get
     * a fresh random id downstream instead (`toV2SessionUpdate`), so there is nothing to key on
     * ahead of time.
     */
    private async sendReplayMessageStart(
        session: ACPSessionConnection,
        update: UpdateSessionEvent,
        started: Set<string>,
    ): Promise<void> {
        const kind = replayMessageStartKind(update.sessionUpdate);
        const messageId = kind ? (update as {messageId?: string | null}).messageId : null;
        if (!kind || !messageId) {
            return;
        }
        const key = `${kind}:${messageId}`;
        if (started.has(key)) {
            return;
        }
        started.add(key);
        await session.startReplayMessage(kind, messageId);
    }

    private async streamNativeThreadHistory(
        sessionId: string,
        itemPages: AsyncIterable<ThreadItem[]>,
        sessionState: SessionState,
        ancestry: Set<string>,
        unreadableChildren: Set<string>,
        isOpen: () => boolean,
    ): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        const announced = new Map<string, {generation: number; sessionId: string; terminal: boolean}>();
        // v2 only (this path also serves v1's native replay, unchanged there).
        const startedReplayMessages = new Set<string>();
        for await (const items of itemPages) {
            for (const item of items) {
                if (!isOpen()) throw new SessionClosedDuringLoadError();
                if (item.type === "subAgentActivity") {
                    const activityKind = item.kind as string;
                    if (activityKind === "started" || activityKind === "interacted") {
                        const previous = announced.get(item.agentThreadId);
                        if (previous && !previous.terminal) continue;
                        // A follow-up to a finished child is an `interacted` activity.
                        if (activityKind === "interacted" && !previous) continue;
                        const generation = (previous?.generation ?? 0) + 1;
                        const childSessionId = generation === 1
                            ? item.agentThreadId
                            : `${item.agentThreadId}:generation:${generation}`;
                        // Each generation of a child is one turn of the child thread. The
                        // adapter reads only the items of that turn, one page at a time.
                        let childItems: AsyncIterable<ThreadItem[]> | null = null;
                        if (!ancestry.has(item.agentThreadId) && !unreadableChildren.has(item.agentThreadId)) {
                            try {
                                childItems = await this.codexAcpClient.readSessionTurnItems(item.agentThreadId, generation - 1);
                            }
                            catch (error) {
                                unreadableChildren.add(item.agentThreadId);
                                logger.error(`Failed to read subagent history ${item.agentThreadId}`, error);
                            }
                        }
                        // An interaction that started no child turn is not a new generation.
                        if (activityKind === "interacted" && !childItems) continue;
                        const name = nameFromAgentPath(item.agentPath, `Agent ${item.agentThreadId.slice(-8)}`);
                        await session.update({
                            sessionUpdate: "subagent_spawned",
                            subagentSessionId: childSessionId,
                            name,
                            task: `Delegated task for ${name}`,
                            capabilities: {},
                        });
                        announced.set(item.agentThreadId, {generation, sessionId: childSessionId, terminal: false});
                        if (childItems) {
                            const commandIds = new Set<string>();
                            try {
                                await this.streamNativeThreadHistory(
                                    childSessionId,
                                    withCommandIds(untilSessionClose(childItems, isOpen), commandIds),
                                    sessionState,
                                    new Set([...ancestry, item.agentThreadId]),
                                    unreadableChildren,
                                    isOpen,
                                );
                            }
                            catch (error) {
                                if (error instanceof SessionClosedDuringLoadError) throw error;
                                // The child pages are read lazily. A child that fails midway keeps what it sent.
                                unreadableChildren.add(item.agentThreadId);
                                logger.error(`Failed to read subagent history ${item.agentThreadId}`, error);
                            }
                            try {
                                await sessionState.asyncTasks.recover(
                                    item.agentThreadId,
                                    childSessionId,
                                    commandIds,
                                );
                            } catch (error) {
                                logger.error(`Failed to restore background terminals for ${item.agentThreadId}`, error);
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
                // The activity items above replay the lifecycle of a spawn. A control call is a tool call, as in the live session.
                if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") continue;
                for (const update of await this.createHistoryUpdates(item, sessionState)) {
                    if (this.protocolVersion === 2) {
                        await this.sendReplayMessageStart(session, update, startedReplayMessages);
                    }
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

    private async streamStandardThreadHistory(
        sessionId: string,
        itemPages: AsyncIterable<SubagentHistoryItem[]>,
        sessionState: SessionState,
        ancestry: Set<string>,
        isOpen: () => boolean,
        threadId: string = sessionId,
        replayedChildren = new Set<string>(),
    ): Promise<void> {
        const router = sessionState.subagents;
        if (!(router instanceof StandardSubagentEventRouter)) return;
        const session = new ACPSessionConnection(this.connection, sessionId);
        const started = new Set<string>();
        const replayChild = async (childThreadId: string, childId: string | null) => {
            if (childId === null || ancestry.has(childThreadId) || replayedChildren.has(childThreadId)) return;
            replayedChildren.add(childThreadId);
            try {
                const history = await this.codexAcpClient.readSessionItems(childThreadId);
                if (!isOpen()) throw new SessionClosedDuringLoadError();
                const parentThreadId = router.parentThreadId(childThreadId);
                if (parentThreadId !== undefined) {
                    try {
                        const runtime = await this.codexAcpClient.restoreSubagentSubscription(sessionState.sessionId, parentThreadId, history.thread);
                        if (runtime) await router.restoreRuntime(runtime, this.codexAcpClient.appServerClient.runningTurnId(childThreadId));
                    } catch (error) {
                        logger.error(`Failed to restore subagent subscription ${childThreadId}`, error);
                    }
                }
                await this.streamStandardThreadHistory(
                    childId, history.items, sessionState, new Set([...ancestry, childThreadId]),
                    isOpen, childThreadId, replayedChildren,
                );
            } catch (error) {
                if (error instanceof SessionClosedDuringLoadError) throw error;
                logger.error(`Failed to replay subagent ${childThreadId}`, error);
            }
        };
        const unresolved: Array<ThreadItem & {type: "subAgentActivity"}> = [];
        for await (const items of itemPages) {
            for (const {item, completed, turnId} of items) {
                if (!isOpen()) throw new SessionClosedDuringLoadError();
                // Native child input comes from agents, not ordinary client user messages.
                if (threadId !== sessionState.sessionId && item.type === "userMessage") continue;
                if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
                    if (item.senderThreadId === threadId) {
                        for (const child of item.receiverThreadIds) {
                            if (child.trim() && !ancestry.has(child)) {
                                const childId = await router.announce(child, sessionId, undefined, item.prompt ?? undefined);
                                await replayChild(child, childId);
                            }
                        }
                    }
                    continue;
                }
                if (item.type === "subAgentActivity") {
                    if (isRootAgentPath(item.agentPath) || ancestry.has(item.agentThreadId)) continue;
                    await replayChild(item.agentThreadId, await router.announceHistory(item.agentThreadId, item.agentPath));
                    if (!replayedChildren.has(item.agentThreadId)) unresolved.push(item);
                    continue;
                }
                const partial = !completed;
                // Running commands may overlap buffered live output; replay their metadata, not bytes twice.
                const replayItem = item.type === "commandExecution" && partial ? {...item, aggregatedOutput: null} : item;
                for (const update of await this.createHistoryUpdates(replayItem, sessionState)) {
                    if (this.protocolVersion === 2) await this.sendReplayMessageStart(session, update, started);
                    await session.update(update);
                }
                if (threadId !== sessionState.sessionId) router.reconcileHistoryItem(threadId, item, completed, turnId);
            }
        }
        for (const item of unresolved) {
            await replayChild(item.agentThreadId, await router.announceHistory(item.agentThreadId, item.agentPath));
        }
        if (!isOpen()) throw new SessionClosedDuringLoadError();
        // History-only children have no confirmed current state or enabled mutations.
    }

    private async publishThreadHistoryTitle(
        session: ACPSessionConnection,
        sessionState: SessionState,
        thread: Thread,
        firstItems: ThreadItem[],
    ): Promise<void> {
        const explicitTitle = normalizeSessionTitle(thread.name);
        if (explicitTitle) {
            sessionState.sessionTitle = explicitTitle;
            sessionState.sessionTitleSource = "explicit";
            sessionState.titleGen?.markExistingTitle();
            await session.update({
                sessionUpdate: "session_info_update",
                title: explicitTitle,
            });
            return;
        }

        const historyTitle = this.findFirstUserMessageTitle(firstItems)
            ?? normalizeSessionTitle(thread.preview);
        await this.publishFallbackSessionTitle(sessionState, historyTitle);
    }

    private findFirstUserMessageTitle(items: ThreadItem[]): string | null {
        for (const item of items) {
            if (item.type !== "userMessage") continue;
            const title = normalizeSessionTitle(item.content
                .filter((input): input is Extract<UserInput, {type: "text"}> => input.type === "text")
                .map(input => input.text)
                .join(" "));
            if (title) return title;
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
        turnDiff: string,
        workspace: AgentFileChangeWorkspace,
    ): Promise<void> {
        let report: AgentFileChangeReport;
        try {
            report = turnId === null
                ? createUnavailableAgentFileChangeReport(request.requestId, unavailableReason)
                : createReportedAgentFileChangeReport(request.requestId, turnDiff, workspace);
        } catch (error) {
            logger.error(
                error instanceof AgentFileChangeReportError
                    ? "Agent file-change report unavailable"
                    : "Agent file-change report failed unexpectedly",
                error,
            );
            report = createUnavailableAgentFileChangeReport(
                request.requestId,
                error instanceof AgentFileChangeReportError ? error.reason : "providerError",
            );
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
        return normalizeSessionTitle(prompt
            .filter((block): block is Extract<acp.ContentBlock, {type: "text"}> => block.type === "text")
            .map(block => block.text)
            .join(" "));
    }

    private async createHistoryUpdates(item: ThreadItem, sessionState: SessionState): Promise<UpdateSessionEvent[]> {
        const renderer = new AcpToolCallRenderer(sessionState.clientCapabilities);
        switch (item.type) {
            case "userMessage":
                return this.createUserMessageUpdates(item);
            case "hookPrompt":
            case "functionCallOutput":
            case "sleep":
                return [];
            case "subAgentActivity":
                return [renderer.render(SubagentActivityReporter.activity(item, "completed", "start"))];
            case "agentMessage": {
                const meta = createMessagePhaseMeta(item.phase, sessionState.clientCapabilities.airClient);
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
                return [renderer.render(FileChangeReporter.started(item, renderer.capabilities.diffPatchFormat))];
            case "commandExecution":
                return CommandReporter.history(item).map(facts => renderer.render(facts));
            case "mcpToolCall":
                return [renderer.render(McpToolReporter.started(item))];
            case "dynamicToolCall":
                return [renderer.render(DynamicToolReporter.started(item))];
            case "collabAgentToolCall":
                return [renderer.render(CollabAgentReporter.started(item))];
            case "webSearch":
                return [renderer.render(WebSearchReporter.history(item))];
            case "imageView":
                return [renderer.render(ImageViewReporter.viewed(item))];
            case "imageGeneration":
                return [renderer.render(ImageGenerationReporter.whole(item))];
            case "enteredReviewMode":
                return [this.createReviewModeUpdate(item, true)];
            case "exitedReviewMode":
                return [this.createReviewModeUpdate(item, false)];
            case "contextCompaction":
                return [clientSupportsCompaction(this.clientCapabilities)
                    ? createCompactionUpdate(item.id, "completed")
                    : renderer.render(CompactionReporter.history(item))];
            case "plan":
                return item.text.length > 0 ? [this.createPlanHistoryUpdate(item)] : [];
        }
    }

    private createUserMessageUpdates(item: ThreadItem & { type: "userMessage" }): UpdateSessionEvent[] {
        const updates: UpdateSessionEvent[] = [];
        // On v2, a message inserted via `session/prompt` is replayed under the id the client
        // provided then (`clientId`), so it round-trips as the same message on reconnect; v1 has
        // no such client-minted id and keeps using Codex's own item id.
        const messageId = this.protocolVersion === 2 ? (item.clientId ?? item.id) : item.id;
        const contentBlocks = item.content.map(input => this.userInputToContentBlocks(input));
        const attachmentUris = new Set(contentBlocks.flatMap((blocks, index) =>
            item.content[index]?.type === "text"
                ? blocks.flatMap(block => block.type === "resource_link" ? [block.uri] : [])
                : []));
        for (const [index, input] of item.content.entries()) {
            const nativePath = input.type === "localImage" || input.type === "localAudio" || input.type === "mention"
                ? input.path
                : (input.type === "image" || input.type === "audio") && "url" in input ? input.url : null;
            if (nativePath !== null && attachmentUris.has(attachmentFileUri(nativePath) ?? "")) continue;
            const blocks = contentBlocks[index]!;
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

    private createReviewModeUpdate(
        item: ThreadItem & { type: "enteredReviewMode" | "exitedReviewMode" },
        entered: boolean
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            // v2 requires a replayed message to carry a stable id; use the persisted item id.
            // v1 keeps no id here, to stay byte-identical with existing clients.
            ...(this.protocolVersion === 2 ? {messageId: item.id} : {}),
            content: {
                type: "text",
                text: `${entered ? "Entered" : "Exited"} review mode: ${item.review}`,
            },
        };
    }

    private createPlanHistoryUpdate(
        item: ThreadItem & { type: "plan" }
    ): UpdateSessionEvent {
        if (this.capabilities.planUpdates) {
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
            createMessagePhaseMeta("final_answer", this.capabilities.airClient),
        );
    }

    private userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
        switch (input.type) {
            case "text":
                return desktopAttachmentHistory(input.text)
                    ?? (input.text.length > 0 ? [{ type: "text", text: input.text }] : []);
            case "image":
                return [{
                    type: "text",
                    text: "url" in input
                        ? this.formatUriAsLink("image", input.url)
                        : `image:${input.fileId}`,
                }];
            case "localImage":
            case "localAudio":
            case "mention": {
                const uri = attachmentFileUri(input.path);
                const fileName = input.path.split(/[\\/]/).pop() || input.type;
                const name = input.type === "mention" && input.name.trim().length > 0 ? input.name : fileName;
                return uri !== null
                    ? [{type: "resource_link", name, uri}]
                    : [{type: "text", text: this.formatUriAsLink(name, input.path)}];
            }
            case "skill":
                return [{ type: "text", text: `skill:${input.name} (${input.path})` }];
            case "audio":
                return [{type: "text", text: this.formatUriAsLink("audio", input.url)}];
        }
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
        mcpServers: Array<AcpMcpServer>,
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
        let resolveClientCancelSignal: (value: null) => void = () => {};
        const clientCancelSignal = new Promise<null>((resolve) => {
            resolveClientCancelSignal = resolve;
        });
        const interactionAbortController = new AbortController();

        let completed = false;
        let closeRequested = false;
        const activePrompt: ActivePrompt = {
            completion,
            closeSignal,
            cancelSignal,
            signal: abortController.signal,
            interactionSignal: interactionAbortController.signal,
            cancelRequested: false,
            currentTurn: null,
            requestCancel: () => {
                activePrompt.abortInteractions();
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
            abortInteractions: () => {
                interactionAbortController.abort();
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
            clientCancelled: false,
            clientCancelSignal,
            requestClientCancel: () => {
                activePrompt.clientCancelled = true;
                resolveClientCancelSignal(null);
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
            void this.requestTurnInterrupt(sessionState, turn.threadId, turn.turnId, "Cancel");
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

    /**
     * Takes this session's place in the shared per-session turn-start FIFO. Every codex-acp turn
     * starter (v1 `session/prompt`, v2 `session/prompt`, the goal-continuation and steering
     * fallbacks) calls this synchronously, before its first `await`, so no two starters can ever
     * decide to start a turn based on the same "is something running" snapshot: whichever calls
     * this first is queued ahead. `wait` resolves once the previous reservation on this session
     * releases; the caller must call `release()` exactly once it is safe for the next queued
     * starter to become visibly active (which may be later than when this starter's own request
     * is answered).
     */
    private acquireTurnStartReservation(sessionId: string): TurnStartReservation {
        const previousSlot = this.turnStartQueueTail.get(sessionId);
        const needsWait = previousSlot !== undefined && !previousSlot.settled;
        const wait = needsWait ? previousSlot!.promise : Promise.resolve();
        const slot: {promise: Promise<void>; settled: boolean} = {promise: Promise.resolve(), settled: false};
        let release: () => void = () => {};
        slot.promise = new Promise<void>((resolve) => {
            release = () => {
                slot.settled = true;
                resolve();
            };
        });
        this.turnStartQueueTail.set(sessionId, slot);
        return {wait, needsWait, release};
    }

    /**
     * Registers a callback that aborts a v2 `session/prompt` still queued behind a running turn.
     * Returns an unregister function the caller must invoke once it stops waiting (whether it was
     * cancelled or reached the front of the queue on its own).
     */
    private registerQueuedV2PromptCanceller(sessionId: string, canceller: () => void): () => void {
        let cancellers = this.queuedV2PromptCancellers.get(sessionId);
        if (!cancellers) {
            cancellers = new Set();
            this.queuedV2PromptCancellers.set(sessionId, cancellers);
        }
        cancellers.add(canceller);
        return () => cancellers!.delete(canceller);
    }

    /** Aborts every v2 `session/prompt` currently queued (not yet inserted) for a session. */
    private cancelQueuedV2Prompts(sessionId: string): void {
        const cancellers = this.queuedV2PromptCancellers.get(sessionId);
        if (!cancellers) {
            return;
        }
        for (const canceller of cancellers) {
            canceller();
        }
        cancellers.clear();
    }

    private async interruptPromptTurn(
        sessionState: SessionState,
        turn: { threadId: string, turnId: string },
        requestName: "Cancel" | "Close",
    ): Promise<void> {
        this.codexAcpClient.markTurnStale({
            threadId: turn.threadId,
            turnId: turn.turnId,
        });
        try {
            if (sessionState.subagents instanceof StandardSubagentEventRouter) await this.interruptStandardChildren(sessionState);
            await this.requestTurnInterrupt(sessionState, turn.threadId, turn.turnId, requestName);
        } finally {
            this.codexAcpClient.resolveTurnInterrupted({
                threadId: turn.threadId,
                turnId: turn.turnId,
            });
        }
    }

    /**
     * Sends `turn/interrupt` and retries it against the registration race: right after a
     * turn (or review child turn) is started, Codex can briefly answer "no active turn to
     * interrupt", and once it registers a later turn under a different id, "expected active turn
     * id <completionTurnId> but found <Y>". Both are retried, with the id recomputed on every
     * attempt so a `turn/started` that arrives between retries is picked up.
     */
    private async requestTurnInterrupt(
        sessionState: SessionState,
        threadId: string,
        completionTurnId: string,
        requestName: "Cancel" | "Close",
    ): Promise<void> {
        if (this.recovery !== null && !this.turnAppServerIsLive(threadId)) {
            // The turn died with its app-server. A restarted app-server has no such turn.
            logger.log(`${requestName} - turnInterrupt skipped: the app-server of the turn is gone`, {sessionId: threadId});
            return;
        }
        let turnId = codexRunningTurnId(sessionState, completionTurnId);
        for (let attempt = 0; ; attempt++) {
            try {
                await this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
                    threadId,
                    turnId,
                }));
                logger.log(`${requestName} - turnInterrupt succeeded`, {
                    sessionId: threadId,
                    currentTurnId: turnId,
                });
                return;
            } catch (err) {
                const promptStillActive = this.activePrompts.has(threadId);
                const mismatch = parseExpectedActiveTurnMismatch(err);
                const isMismatch = mismatch !== null
                    && mismatch.expected === sessionState.currentTurnId
                    && mismatch.found !== "";
                const retryable = promptStillActive
                    && (isNoActiveTurnError(err) || isMismatch)
                    && attempt < NO_ACTIVE_TURN_RETRY_DELAYS_MS.length;
                if (!retryable) {
                    logger.error(`${requestName} - turnInterrupt failed`, err);
                    return;
                }
                // The interrupt raced the turn's registration in Codex: the prompt
                // is still in flight, so the turn is about to become
                // interruptible. Dropping the interrupt here would let the turn run
                // to completion and answer `end_turn`, which ACP forbids after a
                // `session/cancel`.
                await new Promise(resolve => setTimeout(resolve, NO_ACTIVE_TURN_RETRY_DELAYS_MS[attempt]!));
                // Recompute after the wait: a `turn/started` may have landed in the meantime, and
                // `interruptTurnId` always wins once it is set. Otherwise fall back to the id Codex
                // just reported as active, or to the id we started with.
                turnId = sessionState.interruptTurnId ?? (isMismatch ? mismatch!.found : completionTurnId);
                logger.log(`${requestName} - turn not interruptible yet, retrying`, {
                    sessionId: threadId,
                    currentTurnId: turnId,
                    attempt,
                });
            }
        }
    }

    private turnAppServerIsLive(threadId: string): boolean {
        if (this.recovery === null) return true;
        const sessionState = this.sessions.get(threadId);
        return sessionState === undefined ? this.recovery.isReady() : this.recovery.sessionIsLive(sessionState);
    }

    private interruptLateStartedTurn(sessionState: SessionState, turn: { threadId: string, turnId: string }): void {
        void this.interruptPromptTurn(sessionState, turn, "Close");
    }

    private promptShouldStop(sessionId: string, activePrompt: ActivePrompt): boolean {
        return activePrompt.signal.aborted || this.activePrompts.get(sessionId) !== activePrompt || this.sessionIsClosing(sessionId);
    }

    private async interruptSessionTurn(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
        resolveInterruptedTurn: boolean,
    ): Promise<void> {
        if (sessionState.subagents instanceof StandardSubagentEventRouter) await this.interruptStandardChildren(sessionState);
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
            await this.requestTurnInterrupt(sessionState, sessionState.sessionId, turnId, requestName);
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

    /**
     * v2 `session/prompt`: answers `{messageId}` once the user message is inserted and lets the
     * turn run on in the background. A Codex prompt is inserted when Codex records its user
     * message; a locally handled command has no Codex turn, so it is inserted right away.
     */
    async promptV2(params: acpV2.PromptRequest, signal?: AbortSignal): Promise<acpV2.PromptResponse> {
        this.assertInstructionsReady(params.sessionId);
        const sessionId = params.sessionId;
        const request = toV1PromptRequest(params);
        const sessionState = this.getSessionState(sessionId);
        if (this.sessionIsClosing(sessionId)) {
            throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
        }
        // A prompt overlapping a running one is queued behind it rather than rejected: take this
        // session's place in the shared turn-start FIFO now (before any await), then wait. Nothing
        // observable (response, user message, states) happens until this prompt reaches the front.
        const reservation = this.acquireTurnStartReservation(sessionId);
        if (reservation.needsWait) {
            // `session/cancel`/`session/close` drop this prompt while it waits here: race the
            // FIFO wait against a cancellation signal so the client sees `-32800` right away,
            // instead of only once the running turn ahead of it actually finishes. A
            // `$/cancel_request` for this specific request goes through the same canceller, so it
            // only drops this prompt and leaves the rest of the queue untouched.
            let cancelled = false;
            let markCancelled: () => void = () => { cancelled = true; };
            const cancelSignal = new Promise<void>((resolve) => {
                markCancelled = () => { cancelled = true; resolve(); };
            });
            const unregister = this.registerQueuedV2PromptCanceller(sessionId, markCancelled);
            const onRequestCancelled = () => markCancelled();
            if (signal) {
                if (signal.aborted) {
                    onRequestCancelled();
                } else {
                    signal.addEventListener("abort", onRequestCancelled, {once: true});
                }
            }
            await Promise.race([reservation.wait, cancelSignal]);
            unregister();
            signal?.removeEventListener("abort", onRequestCancelled);
            if (cancelled) {
                // Still release in the FIFO's own order once it is actually this prompt's turn,
                // so anything queued behind it does not start while the current turn is still
                // being interrupted.
                void reservation.wait.then(() => reservation.release());
                throw RequestError.requestCancelled(undefined, `Session ${sessionId} was cancelled before the prompt was inserted`);
            }
        }
        const promptKind = this.availableCommands.classifyPrompt(request.prompt);
        const messageId = randomUUID();
        const session = new ACPSessionConnection(this.connection, sessionId);
        let failure: acpV2.Error | null = null;
        this.v2PromptsInFlight.add(sessionId);
        const sendState = async (state: acpV2.StateUpdate) => {
            try {
                await session.updateState(state);
            } catch (error) {
                logger.error(`Failed to send the '${state.state}' state for session ${sessionId}`, error);
            }
        };
        const startWork = async () => {
            try {
                await AcpV2Connection.of(this.connection)?.startForegroundWork(sessionId);
            } catch (error) {
                logger.error(`Failed to report foreground work for session ${sessionId}`, error);
            }
        };
        const sendIdle = async (response: acp.PromptResponse) => {
            if (failure !== null && response.stopReason !== "cancelled") {
                try {
                    await this.finishOutstandingToolCalls(sessionState);
                } catch (error) {
                    logger.error(`Failed to close tools for failed work in session ${sessionId}`, error);
                }
            }
            await sendState(toV2IdleState(response, failure));
        };
        return await new Promise<acpV2.PromptResponse>((resolve, reject) => {
            let running: Promise<void> | null = null;
            let inserted = false;
            // Set from `onTurnAdopted` when `turn/start` steers this prompt into a turn that was
            // already running unowned: that turn's `running` already went out before this
            // prompt existed, so this prompt must not send a second one.
            let turnWasAdopted = false;
            let startedTurn: {threadId: string, turnId: string} | null = null;
            let requestCancelHandled = false;
            // A `$/cancel_request` for a prompt whose `turn/start` was sent but has not landed
            // yet still has a pending request to answer: interrupt the turn it started (like
            // v1's `observePromptRequestCancellation`) and drop it with `-32800`. A turn this
            // prompt only adopted belongs to someone else (e.g. a Codex goal turn) and must
            // keep running -- only this request is dropped, still with `-32800`; whatever that
            // turn actually finishes with is reported normally once `run()` settles below.
            const dropPendingRequest = () => {
                if (inserted || requestCancelHandled) {
                    return;
                }
                requestCancelHandled = true;
                if (!turnWasAdopted && startedTurn !== null) {
                    void this.requestTurnInterrupt(sessionState, startedTurn.threadId, startedTurn.turnId, "Cancel");
                }
                reject(RequestError.requestCancelled(undefined, "The prompt request was cancelled before it was inserted"));
            };
            if (signal) {
                if (signal.aborted) {
                    dropPendingRequest();
                } else {
                    signal.addEventListener("abort", dropPendingRequest, {once: true});
                }
            }
            const onInserted = async () => {
                inserted = true;
                try {
                    for (const block of request.prompt) {
                        await session.update(createUserMessageChunk(block, messageId));
                    }
                } catch (error) {
                    logger.error(`Failed to send the user message for session ${sessionId}`, error);
                }
                resolve({messageId});
                if (turnWasAdopted) {
                    return;
                }
                // Local commands have no runtime turn; insertion starts their foreground work.
                running ??= startWork();
                await running;
            };
            const run = async () => {
                if (promptKind.kind === "localCommand") {
                    await onInserted();
                }
                return await this.prompt(request, undefined, undefined, {
                    clientUserMessageId: messageId,
                    onInserted,
                    onSyntheticInserted: async (syntheticId, prompt) => {
                        try {
                            for (const block of prompt) {
                                await session.update(createUserMessageChunk(block, syntheticId));
                            }
                        } catch (error) {
                            logger.error(`Failed to send the synthetic user message for session ${sessionId}`, error);
                        }
                    },
                    onTurnAdopted: () => {
                        turnWasAdopted = true;
                    },
                    onTurnStarted: (turn) => {
                        startedTurn = turn;
                        // An accepted Codex turn can run hooks before inserting user input.
                        running = startWork();
                    },
                    onFailure: (error) => { failure ??= error; },
                }, reservation);
            };
            run().then(
                async (response) => {
                    this.v2PromptsInFlight.delete(sessionId);
                    if (!inserted) {
                        const notInsertedMessage = "The prompt ended before Codex recorded the user message";
                        // A `cancelled` v1 stop reason means the adopted turn was interrupted
                        // (e.g. by `session/cancel`) before this prompt's input landed: it was
                        // never inserted, so it is dropped with `-32800` like a queued prompt.
                        reject(response.stopReason === "cancelled"
                            ? RequestError.requestCancelled(undefined, notInsertedMessage)
                            : failure !== null
                                ? new RequestError(failure.code, failure.message)
                                : RequestError.internalError(undefined, notInsertedMessage));
                        // Codex dropped the steered input before the adopted turn ended: that
                        // turn's `running` still needs exactly one matching `idle`, and nothing
                        // else will send it now that this prompt is no longer in flight.
                        if (turnWasAdopted || startedTurn !== null) {
                            if (running !== null) await running;
                            await sendIdle(response);
                        }
                        return;
                    }
                    if (running !== null) {
                        await running;
                    }
                    // The session takes the next prompt before `idle` goes out, so a client that
                    // prompts again as soon as it sees `idle` is not rejected as overlapping.
                    // What v1 would have answered with ends the v2 turn.
                    await sendIdle(response);
                },
                async (error: unknown) => {
                    failure ??= toV2Failure(error);
                    if (!inserted) {
                        this.v2PromptsInFlight.delete(sessionId);
                        reject(error);
                        const runtimeLost = this.getExitCode() !== null
                            || this.recovery !== null && !this.recovery.isReady();
                        if (turnWasAdopted || startedTurn !== null || runtimeLost) {
                            if (running !== null) await running;
                            await sendIdle(this.failedPromptResponse(sessionId));
                        }
                        return;
                    }
                    // Past insertion the request is answered, so the failure is told as agent
                    // text (unless the turn already sent it) and the turn still ends with `idle`.
                    logger.error(`Prompt for session ${sessionId} failed after it was inserted`, error);
                    if (running !== null) {
                        await running;
                    }
                    if (!failureWasShownAsMessage(error)) {
                        try {
                            await session.update(createAgentTextMessageChunk(postInsertionFailureText(
                                new Error(failure.message),
                                promptKind.kind === "localCommand" ? promptKind.name : undefined,
                            )));
                        } catch (sendError) {
                            logger.error(`Failed to send the prompt failure for session ${sessionId}`, sendError);
                        }
                    }
                    this.v2PromptsInFlight.delete(sessionId);
                    await sendIdle(this.failedPromptResponse(sessionId));
                },
            ).finally(() => {
                signal?.removeEventListener("abort", dropPendingRequest);
                reservation.release();
                if (!this.sessions.has(sessionId)) AcpV2Connection.of(this.connection)?.forgetSession(sessionId);
            });
        });
    }

    async prompt(
        params: acp.PromptRequest,
        signal?: AbortSignal,
        onTurnStarted?: () => void,
        insertion?: UserMessageInsertion,
        reservation?: TurnStartReservation,
    ): Promise<acp.PromptResponse> {
        this.assertInstructionsReady(params.sessionId);
        // Callers that need to gate additional checks (closing, canStart) atomically with the
        // turn-start slot acquire their own reservation and pass it in; otherwise this call is
        // the v1 entry point and takes the session's turn-start slot itself.
        const ownsReservation = reservation === undefined;
        const activeReservation = reservation ?? this.acquireTurnStartReservation(params.sessionId);
        if (activeReservation.needsWait) {
            await activeReservation.wait;
        }
        try {
            return await this.promptAfterReservation(params, signal, onTurnStarted, insertion);
        } finally {
            if (ownsReservation) {
                activeReservation.release();
            }
        }
    }

    private async promptAfterReservation(
        params: acp.PromptRequest,
        signal?: AbortSignal,
        onTurnStarted?: () => void,
        insertion?: UserMessageInsertion,
    ): Promise<acp.PromptResponse> {
        if (this.providerUpdate !== null) {
            await this.waitForProviderUpdate();
        }
        logger.log("Prompt received", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        const agentFileChangeReportRequest = clientSupportsAgentFileChangeReports(this.clientCapabilities)
            ? parseAgentFileChangeReportRequest(params._meta)
            : null;
        const agentFileChangeWorkspace = agentFileChangeReportRequest === null
            ? null
            : captureAgentFileChangeWorkspace(sessionState.cwd, sessionState.additionalDirectories);
        let agentFileChangeReportTurnId: string | null = null;
        let agentFileChangeReportUnavailableReason: AgentFileChangeReportUnavailableReason = "providerError";
        let promptWasCancelled = false;
        let recoverableSessionFailure = sessionState.sessionFailure;
        sessionState.currentTurnId = null;
        // A prompt that starts no model work, such as /status or a cancellation before the turn, used no tokens.
        sessionState.promptTokenUsage = null;
        sessionState.interruptTurnId = null;
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
        const reportTurnFailure = (turn: Turn) => {
            const error = eventHandler?.getTurnFailure(turn);
            if (error) insertion?.onFailure?.(error);
        };
        let promptNotificationsActive = true;
        // The app-server of this prompt. A restart during the prompt must not mix clients, see AppServerRecovery.
        let promptClient = this.codexAcpClient;
        let promptCommands = this.availableCommands;
        let promptGeneration = this.recovery?.generation ?? 0;
        const appServerLost = new AbortController();
        let removeAppServerLossListener: () => void = () => {};
        let promptElicitations: CodexElicitationHandler | null = null;
        const interactionConnection = this.recovery === null
            ? this.connection
            : lossAwareConnection(this.connection, appServerLost.signal);
        const subagentWaitSignal = this.recovery === null
            ? activePrompt.signal
            : AbortSignal.any([activePrompt.signal, appServerLost.signal]);
        let pendingInsertion = insertion;
        // Synthetic turns codex-acp starts itself inside this same prompt (the plan-implementation
        // follow-up, a `/goal` continuation) each mint their own id and register here, so their
        // userMessage can be told apart from the original prompt's once it lands.
        const pendingSyntheticInsertions = new Map<string, () => Promise<void>>();
        const registerSyntheticInsertion = (clientUserMessageId: string, prompt: acp.ContentBlock[]): void => {
            if (insertion === undefined) {
                return;
            }
            pendingSyntheticInsertions.set(clientUserMessageId, () => insertion.onSyntheticInserted(clientUserMessageId, prompt));
        };
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
            const sessionReady = this.recovery?.ensureSessionReady(sessionState);
            if (sessionReady) {
                // A resume of a large session can take long: a cancel or close during it ends the prompt.
                const readiness = sessionReady.then(() => true);
                readiness.catch(() => undefined);
                const ready = await Promise.race([
                    readiness,
                    activePrompt.closeSignal.then(() => false),
                    activePrompt.cancelSignal.then(() => false),
                    activePrompt.clientCancelSignal.then(() => false),
                ]);
                if (!ready) {
                    return cancelledPromptResponse();
                }
            }
            if (activePrompt.clientCancelled) {
                return cancelledPromptResponse();
            }
            if (this.recovery !== null) {
                promptClient = this.codexAcpClient;
                promptCommands = this.availableCommands;
                promptGeneration = this.recovery.generation;
                removeAppServerLossListener = this.recovery.onGenerationLost(promptGeneration, () => appServerLost.abort());
            }
            const promptEventHandler = new CodexEventHandler(
                this.connection,
                sessionState,
                clientSupportsTypedSessionFailures(this.clientCapabilities),
                this.sessionFailureEpoch,
                sessionState.subagents,
                (accountUpdated) => this.handleAccountUpdated(accountUpdated),
                agentFileChangeReportRequest !== null,
                clientSupportsCompaction(this.clientCapabilities),
                clientSupportsNotices(this.clientCapabilities),
            );
            eventHandler = promptEventHandler;
            const permissionLifecycle = this.permissionLifecycleContext(sessionState);
            const permissionContext = permissionLifecycle.beginPrompt();
            const toolCallRenderer = new AcpToolCallRenderer(this.capabilities);
            const approvalHandler = new CodexApprovalHandler(
                interactionConnection,
                permissionContext,
                activePrompt.interactionSignal,
                toolCallRenderer,
            );
            const elicitationHandler = new CodexElicitationHandler(
                interactionConnection,
                permissionContext,
                this.clientCapabilities,
                activePrompt.interactionSignal,
                toolCallRenderer,
            );
            promptElicitations = elicitationHandler;
            const observeInteraction = async (event: ServerNotification): Promise<void> => {
                const threadId = (event.params as {threadId?: unknown}).threadId;
                if (sessionState.subagents instanceof StandardSubagentEventRouter
                    && typeof threadId === "string" && threadId !== sessionState.sessionId) return;
                permissionContext.handleNotification(event);
                await elicitationHandler.handleNotification(event);
            };
            const resolvePendingInsertion = async (): Promise<void> => {
                if (pendingInsertion === undefined) {
                    return;
                }
                const {onInserted} = pendingInsertion;
                pendingInsertion = undefined;
                await onInserted();
            };
            await promptClient.subscribeToSessionEvents(params.sessionId,
                async (event) => {
                    // Tracks turns this prompt doesn't own too (a `/goal` continuation after this
                    // prompt's own turn already went idle): the same subscription keeps receiving
                    // notifications for as long as no later prompt replaces it.
                    await this.trackCodexForegroundWork(sessionState, event);
                    await this.trackSteerLanding(sessionState, event);
                    this.handleSkillsChanged(sessionState, event);
                    if (pendingInsertion !== undefined
                        && isInsertedUserMessage(event, params.sessionId, pendingInsertion.clientUserMessageId)) {
                        await resolvePendingInsertion();
                    } else {
                        for (const [clientUserMessageId, resolveSynthetic] of pendingSyntheticInsertions) {
                            if (isInsertedUserMessage(event, params.sessionId, clientUserMessageId)) {
                                pendingSyntheticInsertions.delete(clientUserMessageId);
                                await resolveSynthetic();
                                break;
                            }
                        }
                    }
                    await observeInteraction(event);
                    if (!promptNotificationsActive) {
                        await promptEventHandler.handleSessionScopedNotification(event);
                        await this.trackCodexTurnCompletion(sessionState, event, promptEventHandler);
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
                    await this.trackCodexTurnCompletion(sessionState, event, promptEventHandler);
                },
                this.routeChildApprovals(approvalHandler),
                this.routeChildElicitations(elicitationHandler),
                this.supportsNativeSubagents(),
                observeInteraction,
                childThreadId => promptEventHandler.waitForNativeSubagentSession(childThreadId),
                (childId, itemId, request, turnId) => sessionState.subagents.withUserAction?.(childId, itemId, request, turnId) ?? request(),
                event => this.observeSubagentWorkEnd(params.sessionId, event));

            if (activePrompt.signal.aborted) {
                return cancelledPromptResponse();
            }

            const commandPromise = promptCommands.tryHandleCommand(params.prompt, sessionState, {
                signal: activePrompt.signal,
                onTurnStartPending: () => {
                    this.beginPromptTokenUsage(sessionState);
                    ensurePendingTurnStart();
                },
                onTurnStarted: (turnId, threadId) => {
                    const turn = {threadId, turnId};
                    activePrompt.currentTurn = turn;
                    insertion?.onTurnStarted?.(turn);
                    if (this.promptShouldStop(params.sessionId, activePrompt)) {
                        this.interruptLateStartedTurn(sessionState, turn);
                        return;
                    }
                    sessionState.currentTurnId = turnId;
                    pendingTurnStart?.resolve(turnId);
                    onTurnStarted?.();
                },
                ...(insertion === undefined ? {} : {
                    onCommandAccepted: () => {
                        void resolvePendingInsertion();
                    },
                }),
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
                await promptClient.waitForSessionNotifications(params.sessionId);
                await eventHandler.flushPendingErrors();
                await eventHandler.flushPendingErrorsAsSessionScoped();
                if (commandResult.turnCompleted) {
                    await eventHandler.handleFailedTurn(commandResult.turnCompleted.turn);
                    if (insertion && activePrompt.clientCancelled && commandResult.turnCompleted.turn.status === "failed") {
                        return cancelledPromptResponse();
                    }
                    reportTurnFailure(commandResult.turnCompleted.turn);
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
                    usage: this.buildPromptUsage(sessionState),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

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

            if (!sessionState.supportedInputModalities.includes("image") && params.prompt.some(b => b.type === "image")) {
                throw RequestError.invalidRequest("The current model does not support image input");
            }
            const agentMode = sessionState.agentMode;
            const serviceTier = resolveFastServiceTier(
                sessionState.fastModeEnabled,
                sessionState.currentModelSupportsFast,
            );
            this.beginPromptTokenUsage(sessionState);
            ensurePendingTurnStart();
            // Snapshot right before dispatch (no await in between): if a turn is already
            // running here, it is unowned (this prompt hasn't started one yet) and already sent
            // its own `running`.
            const priorRunningTurnId = sessionState.codexReportedRunningTurnId;
            const sendPromptPromise = this.runOnAppServer(promptGeneration, promptClient,
                () => promptClient.sendPrompt(
                    params,
                    agentMode,
                    modelId,
                    serviceTier,
                    disableSummary,
                    sessionState.cwd,
                    sessionState.additionalDirectories,
                    (turnId) => {
                        const turn = {threadId: params.sessionId, turnId};
                        activePrompt.currentTurn = turn;
                        insertion?.onTurnStarted?.(turn);
                        if (this.promptShouldStop(params.sessionId, activePrompt)) {
                            this.interruptLateStartedTurn(sessionState, turn);
                            return;
                        }
                        sessionState.currentTurnId = turnId;
                        pendingTurnStart?.resolve(turnId);
                        if (priorRunningTurnId !== null && turnId === priorRunningTurnId) {
                            insertion?.onTurnAdopted?.();
                        }
                        onTurnStarted?.();
                    },
                    () => this.promptShouldStop(params.sessionId, activePrompt),
                    insertion?.clientUserMessageId,
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

            await promptClient.waitForSessionNotifications(params.sessionId);
            if (turnCompleted.turn.status === "completed") {
                await eventHandler.waitForNativeSubagents(subagentWaitSignal);
                if (activePrompt.signal.aborted) return cancelledPromptResponse();
                this.throwIfSubagentWaitLost(appServerLost.signal, sessionState, promptGeneration);
                await promptClient.waitForSessionNotifications(params.sessionId);
            }
            else {
                await eventHandler.finishOutstandingNativeSubagents(
                    turnCompleted.turn.status === "interrupted" ? "cancelled" : "failed",
                );
            }
            await eventHandler.flushPendingErrors();
            await eventHandler.handleFailedTurn(turnCompleted.turn);
            if (insertion && activePrompt.clientCancelled && turnCompleted.turn.status === "failed") {
                return cancelledPromptResponse();
            }
            reportTurnFailure(turnCompleted.turn);
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
                    activePrompt.interactionSignal,
                    interactionConnection,
                );
                // `cancelRequested` catches plain `session/cancel`, which doesn't abort `signal`
                // (that would also change pre-turn prompt flow); without it this branch would
                // fall through to `end_turn` instead of `cancelled`.
                if (this.promptShouldStop(params.sessionId, activePrompt) || activePrompt.cancelRequested) {
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
                    sessionState.interruptTurnId = null;
                    // This second turn stays inside the original prompt's running…idle pair, so it
                    // gets its own minted id rather than reusing the first turn's.
                    const implementationClientUserMessageId = insertion !== undefined ? randomUUID() : undefined;
                    if (implementationClientUserMessageId !== undefined) {
                        registerSyntheticInsertion(implementationClientUserMessageId, implementationRequest.prompt);
                    }
                    const implementationPromise = this.runOnAppServer(promptGeneration, promptClient,
                        () => promptClient.sendPrompt(
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
                                    this.interruptLateStartedTurn(sessionState, turn);
                                    return;
                                }
                                sessionState.currentTurnId = turnId;
                                // Keep the approval-to-turn-start gap session-scoped. Once the new turn has
                                // an identity, snapshot any unchanged session failure as its recovery baseline.
                                recoverableSessionFailure = sessionState.sessionFailure;
                                promptNotificationsActive = true;
                            },
                            () => this.promptShouldStop(params.sessionId, activePrompt),
                            implementationClientUserMessageId,
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

                    await promptClient.waitForSessionNotifications(params.sessionId);
                    if (turnCompleted.turn.status === "completed") {
                        await eventHandler.waitForNativeSubagents(subagentWaitSignal);
                        if (activePrompt.signal.aborted) return cancelledPromptResponse();
                        this.throwIfSubagentWaitLost(appServerLost.signal, sessionState, promptGeneration);
                        await promptClient.waitForSessionNotifications(params.sessionId);
                    }
                    else {
                        await eventHandler.finishOutstandingNativeSubagents(
                            turnCompleted.turn.status === "interrupted" ? "cancelled" : "failed",
                        );
                    }
                    await eventHandler.flushPendingErrors();
                    await eventHandler.handleFailedTurn(turnCompleted.turn);
                    if (insertion && activePrompt.clientCancelled && turnCompleted.turn.status === "failed") {
                        return cancelledPromptResponse();
                    }
                    reportTurnFailure(turnCompleted.turn);
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

            // A skill that appeared during the turn becomes a slash command after it, even when the
            // `skills/changed` notification of its file was missed. Never await: the prompt response does not
            // wait for the skill list.
            const turnSessionGeneration = this.getSessionGeneration(sessionState.sessionId);
            void this.availableCommands.publish(
                sessionState,
                () => this.sessionPublishIsCurrent(sessionState, turnSessionGeneration),
                true,
            );

            // Fire-and-forget: generate an AI title from the first turn.
            // Never await — must not block the prompt response.
            // Note: turn.items contains only agent output, not the user message —
            // extract prompt text from params instead.
            if (sessionState.titleGen) {
                const promptText = params.prompt
                    .filter((b): b is Extract<acp.ContentBlock, { type: "text" }> => b.type === "text")
                    .map(b => b.text)
                    .join(" ")
                    .trim();
                sessionState.titleGen.onTurnCompleted(promptText);
            }

            // On v2, a prompt whose user message was never recorded (`pendingInsertion` still set)
            // never happened from the client's view, so it must not leave a title behind either.
            if (pendingInsertion === undefined) {
                await this.publishFallbackSessionTitle(
                    sessionState,
                    this.createPromptFallbackTitle(params.prompt),
                );
            }

            return {
                stopReason: "end_turn",
                usage: this.buildPromptUsage(sessionState),
                _meta: this.buildQuotaMeta(sessionState),
            };
        } catch (caught) {
            const err = this.recovery?.mapError(caught, promptClient) ?? caught;
            logger.error(`Prompt for session ${params.sessionId} failed`, err);
            const lostAppServer = this.recovery !== null
                && err instanceof RequestError
                && err.code === CODEX_PROCESS_EXITED_ERROR_CODE;
            if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId) || insertion && activePrompt.clientCancelled) {
                if (lostAppServer) await this.finishPromptAfterAppServerLoss(sessionState, eventHandler, promptClient, promptElicitations, "cancelled");
                return cancelledPromptResponse();
            }
            agentFileChangeReportTurnId = null;
            agentFileChangeReportUnavailableReason = "providerError";
            const isProcessExit = err instanceof RequestError
                && err.code === CODEX_PROCESS_EXITED_ERROR_CODE;
            if (lostAppServer) {
                // ACP: a prompt that the client cancelled answers `cancelled`, also when the app-server died meanwhile.
                if (activePrompt.clientCancelled) {
                    await this.finishPromptAfterAppServerLoss(sessionState, eventHandler, promptClient, promptElicitations, "cancelled");
                    return cancelledPromptResponse();
                }
                await this.finishPromptAfterAppServerLoss(sessionState, eventHandler, promptClient, promptElicitations, "failed");
                // A cancel that came while the cleanup published still wins (ACP: a cancelled prompt answers `cancelled`).
                if (activePrompt.clientCancelled || activePrompt.signal.aborted) {
                    return cancelledPromptResponse();
                }
            }
            insertion?.onFailure?.(toV2Failure(err));
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
                await promptClient.waitForSessionNotifications(params.sessionId);
                await eventHandler?.finishOutstandingNativeSubagents(
                    promptWasCancelled || activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)
                        ? "cancelled"
                        : "failed",
                );
            } catch (error) {
                logger.error("Failed to publish terminal compaction or subagent state during prompt cleanup", error);
            }
            if (agentFileChangeReportRequest !== null && agentFileChangeWorkspace !== null) {
                if (promptWasCancelled || activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)) {
                    agentFileChangeReportTurnId = null;
                    agentFileChangeReportUnavailableReason = "cancelled";
                } else if (agentFileChangeReportTurnId !== null
                    && eventHandler?.isTurnDiffOversized(agentFileChangeReportTurnId)) {
                    agentFileChangeReportTurnId = null;
                    agentFileChangeReportUnavailableReason = "invalidOutput";
                }
                await this.publishAgentFileChangeReport(
                    sessionState,
                    agentFileChangeReportTurnId,
                    agentFileChangeReportRequest,
                    agentFileChangeReportUnavailableReason,
                    agentFileChangeReportTurnId === null || eventHandler === null
                        ? ""
                        : eventHandler.getTurnDiff(agentFileChangeReportTurnId),
                    agentFileChangeWorkspace,
                );
            }
            logger.log("Prompt completed", {sessionId: params.sessionId});
            await eventHandler?.dispose();
            disposePromptRequestCancellation();
            removeAppServerLossListener();
            sessionState.currentTurnId = null;
            sessionState.interruptTurnId = null;
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
        connection: AcpClientConnection = this.connection,
    ): Promise<boolean> {
        const renderer = new AcpToolCallRenderer(sessionState.clientCapabilities);
        try {
            const response = await connection.request(
                acp.methods.client.session.requestPermission,
                PlanReviewReporter.permissionRequest(sessionState.sessionId, plan, renderer),
                {cancellationSignal},
            );
            const approved = PlanReviewReporter.approved(response);
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId: sessionState.sessionId,
                update: renderer.render(PlanReviewReporter.decided(plan, approved)),
            });
            return approved;
        } catch (error) {
            // The app-server died while the dialog was open: the prompt fails with its exit, see LossAwareConnection.
            if (error instanceof AppServerConnectionLostError) throw error;
            logger.error("Error requesting plan implementation permission", error);
            return false;
        }
    }

    /**
     * The wait for native subagents ended because the app-server died while some still ran: the prompt fails with the
     * exit. A turn that completed before the app-server died, with no subagent left, still ends normally.
     */
    private throwIfSubagentWaitLost(lost: AbortSignal, sessionState: SessionState, generation: number): void {
        if (this.recovery === null || !lost.aborted || !sessionState.subagents.hasOutstanding()) return;
        throw this.recovery.errorForGeneration(generation);
    }

    /**
     * Ends what a prompt showed as running when its app-server died: open tool calls of the session and of its native
     * subagent sessions, the subagent sessions themselves and compactions. Nothing will ever complete them.
     */
    private async finishPromptAfterAppServerLoss(
        sessionState: SessionState,
        eventHandler: CodexEventHandler | null,
        promptClient: CodexAcpClient,
        elicitations: CodexElicitationHandler | null,
        state: "failed" | "cancelled",
    ): Promise<void> {
        try {
            await elicitations?.completeAllUrlElicitations();
            const sessionIds = new Set([sessionState.sessionId, ...sessionState.subagents.childSessionIds()]);
            await this.failUnfinishedToolCalls(sessionIds);
            // Ending the subagent sessions also ends the waits of queued notifications for them. The dead app-server
            // sends nothing more, so the queue then drains. A tool call or a subagent session that the queue still
            // starts is failed and ended in a second pass.
            await eventHandler?.finishOutstandingNativeSubagents(state);
            await promptClient.waitForSessionNotifications(sessionState.sessionId);
            for (const childSessionId of sessionState.subagents.childSessionIds()) sessionIds.add(childSessionId);
            await this.failUnfinishedToolCalls(sessionIds);
            await eventHandler?.finishOutstandingNativeSubagents(state);
        } catch (error) {
            logger.error("Failed to finish the tool calls of a prompt whose app-server died", error);
        }
    }

    private async failUnfinishedToolCalls(sessionIds: Iterable<string>): Promise<void> {
        for (const sessionId of sessionIds) {
            for (const toolCallId of this.reportingConnection.reports.unfinished(sessionId)) {
                await this.connection.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: {sessionUpdate: "tool_call_update", toolCallId, status: "failed"},
                });
            }
        }
    }

    private cancelledPromptResponse(sessionState: SessionState): acp.PromptResponse {
        return {
            stopReason: "cancelled",
            usage: this.buildPromptUsage(sessionState),
            _meta: this.buildQuotaMeta(sessionState),
        };
    }

    /** The v1-shaped result of a prompt that failed after insertion, for its v2 `idle`. */
    private failedPromptResponse(sessionId: string): acp.PromptResponse {
        const sessionState = this.sessions.get(sessionId);
        if (sessionState === undefined) {
            return {stopReason: "end_turn"};
        }
        return {
            stopReason: "end_turn",
            usage: this.buildPromptUsage(sessionState),
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
            usage: this.buildPromptUsage(sessionState),
            _meta: {
                ...this.buildQuotaMeta(sessionState),
                ...failureMeta,
            },
        };
    }

    /** `_meta.quota`: the usage of the whole prompt, the same counts as {@link buildPromptUsage}. */
    private buildQuotaMeta(sessionState: SessionState): { quota: QuotaMeta } {
        const promptTokenUsage = sessionState.promptTokenUsage?.usage() ?? null;

        // Remove the "[reasoning-level]" suffix from currentModelId if present
        const modelName = sessionState.currentModelId.replace(/\[.*?]$/, '');

        // FIXME: currently all tokens are reported for the current model
        const modelUsage = (promptTokenUsage != null)
            ? [{ model: modelName, token_count: promptTokenUsage }]
            : [];

        return {
            quota: {
                token_count: promptTokenUsage,
                model_usage: modelUsage
            }
        };
    }

    private beginPromptTokenUsage(sessionState: SessionState): void {
        sessionState.lastTokenUsage = null;
        // A new thread starts at zero; the usage of a thread with history is unknown until Codex reports it.
        const startTotal = sessionState.totalTokenUsage
            ?? (sessionState.threadHasHistory ? null : ZERO_TOKEN_COUNT);
        sessionState.promptTokenUsage = new PromptTokenUsage(startTotal);
    }

    private buildPromptUsage(sessionState: SessionState): acp.Usage | null {
        const usage = sessionState.promptTokenUsage?.usage() ?? null;
        return usage === null ? null : toPromptUsage(usage);
    }

    /**
     * Runs an app-server operation and maps a failure because the app-server is gone to a clear error.
     * It never starts the app-server again: the entry points of user requests do that, see {@link ensureAppServer}.
     * `client` is the client that the operation uses, by default the installed one at the call.
     */
    private async runWithProcessCheck<T>(operation: () => Promise<T>, client = this.codexAcpClient): Promise<T> {
        try {
            return await operation();
        } catch (err) {
            if (this.recovery !== null) {
                throw this.recovery.mapError(err, client);
            }
            const exitCode = this.getExitCode();
            const requestErrorCode = CODEX_PROCESS_EXITED_ERROR_CODE;
            if (exitCode == 3221225781) {
                throw new RequestError(requestErrorCode, `VC++ redistributable should be installed`);
            }
            if (exitCode !== null) {
                await this.finishAllAsyncTasks("failed", "after the Codex process exited");
                const stderr = this.getRecentStderr().trim();
                const detail = stderr ? `:\n${stderr}` : "";
                throw new RequestError(requestErrorCode, `Codex process has exited with code ${exitCode}${detail}`);
            }
            throw err;
        }
    }

    private async finishAllAsyncTasks(state: "failed" | "stopped", reason: string): Promise<void> {
        for (const session of this.sessions.values()) {
            try {
                await session.asyncTasks.finishAll(state);
            } catch (error) {
                logger.error(`Failed to finish background terminal tasks ${reason}`, error);
            }
        }
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        if (this.subagentAssociations.isRestricted(params.sessionId)) return;
        this.activePrompts.get(params.sessionId)?.requestClientCancel();
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) {
            logger.log("Cancel request rejected: session not found", {sessionId: params.sessionId});
            return;
        }

        // Abort outbound permission/elicitation requests synchronously, before awaiting the turn
        // interrupt below (which can itself wait on a pending turn start). Mark cancelRequested so
        // the plan-review branch can detect this cancellation even though it doesn't abort `signal`.
        const activePrompt = this.activePrompts.get(params.sessionId);
        if (activePrompt) {
            activePrompt.cancelRequested = true;
            activePrompt.abortInteractions();
        }

        // Drop every v2 prompt still queued (not yet inserted) before interrupting the running
        // turn, so their `-32800` responses do not wait on the interrupt completing. No-op on v1.
        this.cancelQueuedV2Prompts(params.sessionId);
        // After turnInterrupt(), Codex will send turn/completed, which naturally completes awaitTurnCompleted().
        await this.interruptSessionTurn(sessionState, "Cancel", false);
    }
}

/** A buffered reviewer prompt candidate is shown once its turn has this many items. */
const REVIEWER_PROMPT_CANDIDATE_MAX_ITEMS = 100;

/**
 * The items of `pages` without the reviewer prompts of `/review` runs (user decision: v2 only, v1
 * keeps showing them). A `/review` run persists its reviewer prompt as the first item of its own
 * turn T, which Codex lists just before the review turn P (P's first item is `enteredReviewMode`).
 * T is never shown live, and there is no way to distinguish it from an ordinary preceding turn
 * except that T is minted *after* P: its UUIDv7 turn id sorts higher. Only a turn that can be T is
 * held back, until the first item of the next turn decides.
 */
async function* withoutReviewerPrompts(pages: AsyncIterable<ThreadItemEntry[]>): AsyncGenerator<ThreadItem[]> {
    let turnId: string | null = null;
    let candidate: {turnId: string; items: ThreadItem[]} | null = null;
    for await (const page of pages) {
        const items: ThreadItem[] = [];
        for (const entry of page) {
            const item = entry.item;
            const turnStarts = entry.turnId !== turnId;
            turnId = entry.turnId;
            if (candidate !== null && turnStarts) {
                const hidden = item.type === "enteredReviewMode"
                    && isUuidV7(candidate.turnId) && isUuidV7(entry.turnId) && candidate.turnId > entry.turnId;
                items.push(...(hidden ? candidate.items.slice(1) : candidate.items));
                candidate = null;
            }
            if (turnStarts && item.type === "userMessage" && item.clientId === null) {
                candidate = {turnId: entry.turnId, items: [item]};
                continue;
            }
            if (candidate === null) {
                items.push(item);
                continue;
            }
            candidate.items.push(item);
            // A turn with its own messages is not a reviewer prompt turn.
            if (item.type === "agentMessage" || item.type === "userMessage"
                || candidate.items.length >= REVIEWER_PROMPT_CANDIDATE_MAX_ITEMS) {
                items.push(...candidate.items);
                candidate = null;
            }
        }
        if (items.length > 0) yield items;
    }
    if (candidate !== null) yield candidate.items;
}

/** The items of the entry pages of `pages`. */
async function* itemsOfEntries(pages: AsyncIterable<ThreadItemEntry[]>): AsyncGenerator<ThreadItem[]> {
    for await (const page of pages) {
        yield page.map(entry => entry.item);
    }
}

async function* standardHistoryItems(pages: AsyncIterable<ThreadItem[]>): AsyncGenerator<SubagentHistoryItem[]> {
    for await (const page of pages) {
        yield page.map(item => ({item, completed: !("status" in item) || item.status !== "inProgress"}));
    }
}

function isUuidV7(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The whole-message kind a replayed chunk update restarts, or `null` if it isn't a chunk. */
function replayMessageStartKind(sessionUpdate: UpdateSessionEvent["sessionUpdate"]): ReplayMessageKind | null {
    switch (sessionUpdate) {
        case "user_message_chunk":
            return "user_message";
        case "agent_message_chunk":
            return "agent_message";
        case "agent_thought_chunk":
            return "agent_thought";
        default:
            return null;
    }
}

/** A close of the session stopped the read of its history during `session/load`. */
class SessionClosedDuringLoadError extends Error {
    constructor() {
        super("The session closed during the history load");
    }
}

/** The pages of `pages` while `isOpen` is true. A close of the session stops the read at the next page. */
async function* untilSessionClose<T>(pages: AsyncIterable<T[]>, isOpen: () => boolean): AsyncGenerator<T[]> {
    for await (const page of pages) {
        if (!isOpen()) throw new SessionClosedDuringLoadError();
        yield page;
    }
}

/** The page `first`, then the pages of `rest`. */
async function* pagesStartingWith<T>(first: T[], rest: AsyncIterator<T[]>): AsyncGenerator<T[]> {
    if (first.length > 0) yield first;
    for (let page = await rest.next(); !page.done; page = await rest.next()) {
        yield page.value;
    }
}

/** The pages of `pages`. Adds the id of each command item to `commandIds`. */
async function* withCommandIds(
    pages: AsyncIterable<ThreadItem[]>,
    commandIds: Set<string>,
): AsyncGenerator<ThreadItem[]> {
    for await (const items of pages) {
        for (const item of items) {
            if (item.type === "commandExecution") commandIds.add(item.id);
        }
        yield items;
    }
}
