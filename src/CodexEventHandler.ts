import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
    ServerNotification
} from "./app-server";
import type {
    SessionFailure,
    SessionFailureAction,
    SessionFailureCategory,
    SessionState,
} from "./CodexAcpServer";
import {type PlanEntry, RequestError} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type AcpClientConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AccountRateLimitsUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    CommandExecutionOutputDeltaNotification,
    ConfigWarningNotification,
    DeprecationNoticeNotification,
    ErrorNotification,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    ThreadItem,
    ModelReroutedNotification,
    PlanDeltaNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    TerminalInteractionNotification,
    ThreadGoalClearedNotification,
    ThreadGoalUpdatedNotification,
    ThreadTokenUsageUpdatedNotification,
    Turn,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import type { McpStartupCompleteEvent } from "./app-server/McpStartupCompleteEvent";
import {toTokenCount} from "./TokenCount";
import {
    commandExecutionUsesTerminalOutput,
    createCommandExecutionUpdate,
    createContextCompactionCompleteUpdate,
    createContextCompactionStartUpdate,
    createDynamicToolCallUpdate,
    createFileChangeUpdate,
    createGuardianApprovalReviewToolCall,
    createGuardianApprovalReviewToolCallUpdate,
    createImageGenerationCompleteUpdate,
    createImageGenerationStartUpdate,
    createImageGenerationUpdate,
    createImageViewUpdate,
    createMcpRawInput,
    createMcpRawOutput,
    createFuzzyFileSearchComplete,
    createFuzzyFileSearchStartOrUpdate,
    createMcpToolCallUpdate,
    createWebSearchCompleteUpdate,
    createWebSearchStartUpdate,
    fuzzyFileSearchToolCallId,
} from "./CodexToolCallMapper";
import { stripShellPrefix } from "./CommandUtils";
import {createTerminalOutputMeta, type TerminalOutputMode} from "./TerminalOutputMode";
import {
    createCodexMessagePhaseMeta,
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
} from "./ContentChunks";
import {sameThreadGoalSnapshot, type ThreadGoalSnapshot, toThreadGoalSnapshot} from "./ThreadGoalSnapshot";
import {logger} from "./Logger";
import {randomUUID} from "node:crypto";
import {
    AIR_EXTENSION_VERSION,
    AIR_EXTENSION_VERSION_KEY,
    AIR_META_KEY,
    AIR_SESSION_FAILURE_KEY,
    JETBRAINS_META_KEY,
} from "./AirExtension";
import {CodexSubagentEventRouter} from "./subagents/CodexSubagentEventRouter";
import type {SubagentState} from "./subagents/AcpSubagents";

export { stripShellPrefix };

export type CompletedPlan = {
    itemId: string;
    text: string;
};

type CodexFailureKind =
    | "transport_lost" | "auth_required" | "rate_limited" | "quota_exhausted" | "overloaded"
    | "context_exhausted" | "budget_exhausted" | "policy_denied" | "bad_request"
    | "provider_error" | "internal_error";

type SessionFailurePolicy = {
    category: SessionFailureCategory;
    actions: SessionFailureAction[];
};

const MAX_SESSION_FAILURE_TITLE_LENGTH = 240;

const SESSION_FAILURE_POLICY: Record<CodexFailureKind, SessionFailurePolicy> = {
    transport_lost: {
        category: "connection",
        actions: ["retry", "new_session"],
    },
    auth_required: {
        category: "access",
        actions: ["login"],
    },
    rate_limited: {
        category: "limit",
        actions: ["retry"],
    },
    quota_exhausted: {
        category: "limit",
        actions: [],
    },
    overloaded: {
        category: "service",
        actions: ["retry"],
    },
    context_exhausted: {
        category: "limit",
        actions: ["new_session"],
    },
    budget_exhausted: {
        category: "limit",
        actions: ["new_session"],
    },
    policy_denied: {
        category: "request",
        actions: [],
    },
    bad_request: {
        category: "request", actions: [],
    },
    provider_error: {
        category: "service",
        actions: ["retry"],
    },
    internal_error: {
        category: "service",
        actions: ["retry", "new_session"],
    },
};

const SYNTHETIC_FAILURE_TITLE: Record<"transport_lost" | "internal_error", string> = {
    transport_lost: "Connection to Codex was lost.",
    internal_error: "Codex encountered an internal error.",
};

/**
 * Records sharing an id form one logical banner whose revisions must increase; a new id restarts at 1.
 */
function nextSessionFailureRevision(previous: SessionFailure | undefined, id: string): number {
    return previous?.id === id ? previous.revision + 1 : 1;
}

type StringCodexErrorInfo = Extract<CodexErrorInfo, string>;
type StructuredCodexErrorInfo = Exclude<CodexErrorInfo, string>;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type StructuredCodexErrorKind = KeysOfUnion<StructuredCodexErrorInfo>;

/**
 * Exhaustive against the generated app-server union: a schema update cannot silently fall through
 * to provider_error. The runtime lookup still has a fallback for a newer app-server talking to an
 * older codex-acp build.
 */
const STRING_CODEX_ERROR_CATEGORIES = {
    contextWindowExceeded: "context_exhausted",
    sessionBudgetExceeded: "budget_exhausted",
    usageLimitExceeded: "quota_exhausted",
    serverOverloaded: "overloaded",
    cyberPolicy: "policy_denied",
    misalignmentPolicyViolation: "policy_denied",
    internalServerError: "internal_error",
    unauthorized: "auth_required",
    badRequest: "bad_request",
    threadRollbackFailed: "provider_error",
    sandboxError: "provider_error",
    other: "provider_error",
} satisfies Record<StringCodexErrorInfo, CodexFailureKind>;

const STRUCTURED_CODEX_ERROR_CATEGORIES = {
    httpConnectionFailed: "transport_lost",
    responseStreamConnectionFailed: "transport_lost",
    responseStreamDisconnected: "transport_lost",
    responseTooManyFailedAttempts: "transport_lost",
    activeTurnNotSteerable: "provider_error",
} satisfies Record<StructuredCodexErrorKind, CodexFailureKind>;

export class CodexEventHandler {

    private static readonly PLAN_UPDATE_INTERVAL_MS = 150;

    private readonly sessionState: SessionState;
    private readonly supportsPlanUpdates: boolean;
    private readonly supportsTypedSessionFailures: boolean;
    private readonly sessionFailureEpoch: string;
    private readonly pendingErrors: ErrorNotification[] = [];
    private readonly failuresById = new Map<string, SessionFailure>();
    private readonly activeFailureIdByScope = new Map<string, string>();
    private readonly failureTurnIdById = new Map<string, string | undefined>();
    private readonly allocatedFailureScopes = new Set<string>();
    private lastSessionNotice: {key: string; failure: SessionFailure} | undefined;
    private nextNoticeId = 1;
    private failure: RequestError | null = null;
    private completedPlan: CompletedPlan | null = null;
    private readonly activeFuzzyFileSearchSessions = new Set<string>();
    private readonly activeGuardianApprovalReviews = new Set<string>();
    private readonly activeImageGenerationItems = new Set<string>();
    private readonly emittedImageViewItems = new Set<string>();
    private readonly planDeltaTextByItemId = new Map<string, string>();
    private readonly pendingPlanItemIds = new Set<string>();
    private readonly lastEmittedPlanTextByItemId = new Map<string, string>();
    private readonly session: ACPSessionConnection;
    private planUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    private planUpdateChain: Promise<void> = Promise.resolve();
    private disposed = false;
    private readonly seenReasoningDeltaItemIds = new Set<string>();
    private readonly terminalCommandIds = new Set<string>();
    private readonly terminalCommandOutputIds = new Set<string>();
    private readonly agentMessagePhases = new Map<string, string | null>();
    private readonly subagents: CodexSubagentEventRouter;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        supportsPlanUpdates = false,
        supportsTypedSessionFailures = false,
        sessionFailureEpoch: string = randomUUID(),
        subagents: CodexSubagentEventRouter = new CodexSubagentEventRouter(
            sessionState.sessionId,
            false,
            new ACPSessionConnection(connection, sessionState.sessionId),
        ),
    ) {
        this.sessionState = sessionState;
        this.supportsPlanUpdates = supportsPlanUpdates;
        this.supportsTypedSessionFailures = supportsTypedSessionFailures;
        this.sessionFailureEpoch = sessionFailureEpoch;
        this.session = new ACPSessionConnection(connection, sessionState.sessionId);
        this.subagents = subagents;
        if (sessionState.sessionFailure !== undefined) {
            this.failuresById.set(sessionState.sessionFailure.id, sessionState.sessionFailure);
        }
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    getTerminalSessionFailureMeta(
        turnId: string | null,
        allowUnattributed = false,
    ): Record<string, unknown> | null {
        const failure = this.sessionState.sessionFailure;
        if (!this.supportsTypedSessionFailures
            || failure === undefined
            || (this.failureTurnIdById.get(failure.id) === undefined
                ? !allowUnattributed
                : turnId === null || this.failureTurnIdById.get(failure.id) !== turnId)) {
            return null;
        }
        return this.createSessionFailureMeta(failure);
    }

    recordSyntheticTerminalFailure(kind: "transport_lost" | "internal_error", turnId: string | null): void {
        this.recordSessionFailure(kind, turnId ?? undefined, "error", SYNTHETIC_FAILURE_TITLE[kind]);
    }

    /**
     * Handles notifications after the prompt-local handler has been disposed. The app-server subscription
     * remains installed until the ACP session closes, so terminal errors need a durable session-level path
     * instead of entering a turn buffer that will never be flushed.
     */
    async handleSessionScopedNotification(notification: ServerNotification): Promise<void> {
        if (notification.method !== "error") {
            await this.handleNotification(notification);
            return;
        }
        if (!this.supportsTypedSessionFailures) {
            // Preserve the legacy behavior for clients that did not negotiate typed failures.
            await this.handleNotification(notification);
            return;
        }
        if (notification.params.willRetry) {
            await this.session.update(this.createSessionFailureUpdate(this.recordRetryWarning(notification.params, false)));
            return;
        }
        const failure = this.recordSessionFailure(
            this.sessionFailureKind(notification.params.error.codexErrorInfo),
            notification.params.turnId,
            "error",
            notification.params.error.message,
            undefined,
            false,
        );
        await this.session.update(this.createSessionFailureUpdate(failure));
    }

    async flushPendingErrors(): Promise<void> {
        if (this.sessionState.currentTurnId === null || this.pendingErrors.length === 0) {
            return;
        }
        const errors = this.pendingErrors.splice(0);
        for (const error of errors) {
            const update = await this.createErrorEvent(error);
            if (update) {
                await this.session.update(update);
            }
        }
    }

    async flushPendingErrorsAsSessionScoped(): Promise<void> {
        if (!this.supportsTypedSessionFailures || this.pendingErrors.length === 0) {
            return;
        }
        const errors = this.pendingErrors.splice(0);
        for (const error of errors) {
            await this.handleSessionScopedNotification({method: "error", params: error});
        }
    }

    async clearSessionFailure(): Promise<void> {
        delete this.sessionState.sessionFailure;
    }

    async completeSuccessfulTurn(turnId: string | null): Promise<void> {
        this.lastSessionNotice = undefined;
        if (!this.supportsTypedSessionFailures || turnId === null) return;
        const active = this.sessionState.sessionFailure;
        if (active?.id !== this.activeFailureIdByScope.get(turnId) || active?.severity !== "warning") return;
        this.activeFailureIdByScope.delete(turnId);
        delete this.sessionState.sessionFailure;
    }

    async handleFailedTurn(turn: Turn): Promise<void> {
        const activeFailure = this.sessionState.sessionFailure;
        if (!this.supportsTypedSessionFailures
            || turn.status !== "failed"
            || this.failure !== null
            || this.failureTurnIdById.get(activeFailure?.id ?? "") === turn.id && activeFailure?.severity === "error") {
            return;
        }
        const error = turn.error ?? {
            message: "Turn failed",
            codexErrorInfo: null,
            additionalDetails: null,
        };
        this.recordTypedSessionFailure({
            threadId: this.sessionState.sessionId,
            turnId: turn.id,
            willRetry: false,
            error,
        });
    }

    takeCompletedPlan(): CompletedPlan | null {
        const plan = this.completedPlan;
        this.completedPlan = null;
        return plan;
    }

    async handleNotification(notification: ServerNotification) {
        await this.flushPendingErrors();
        const handledBySubagents = await this.subagents.handle(notification);
        for (const buffered of this.subagents.takeBufferedNotifications()) {
            await this.handleNotification(buffered);
        }
        if (handledBySubagents) {
            return;
        }
        if (this.subagents.shouldIgnore(notification)) {
            return;
        }
        const updateEvent = await this.createUpdateEvent(notification);
        if (updateEvent) {
            await this.session.update(updateEvent, this.subagents.notificationSessionId(notification));
        }
    }

    async waitForNativeSubagentSession(childThreadId: string): Promise<string | null> {
        return await this.subagents.waitForMaterializedSession(childThreadId);
    }

    async waitForNativeSubagents(signal: AbortSignal): Promise<void> {
        await this.subagents.wait(signal);
    }

    async finishOutstandingNativeSubagents(state: SubagentState): Promise<void> {
        await this.subagents.finishOutstanding(state);
    }

    async flushPendingPlanUpdates(): Promise<void> {
        this.cancelPlanUpdateTimer();
        do {
            const itemIds = [...this.pendingPlanItemIds];
            this.pendingPlanItemIds.clear();
            await Promise.all(itemIds.map(itemId => {
                const text = this.planDeltaTextByItemId.get(itemId) ?? "";
                return text.length > 0
                    ? this.enqueuePlanSnapshot(itemId, text)
                    : Promise.resolve();
            }));
            await this.planUpdateChain;
        } while (this.pendingPlanItemIds.size > 0);
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.flushPendingPlanUpdates();
        if (this.pendingErrors.length > 0) {
            logger.log("Discarding app-server errors that arrived before a turn started", {
                sessionId: this.sessionState.sessionId,
                count: this.pendingErrors.length,
                turnIds: this.pendingErrors.map(error => error.turnId),
            });
            this.pendingErrors.splice(0);
        }
        this.disposed = true;
        this.cancelPlanUpdateTimer();
        this.pendingPlanItemIds.clear();
        this.planDeltaTextByItemId.clear();
        this.lastEmittedPlanTextByItemId.clear();
    }

    private async createUpdateEvent(notification: ServerNotification): Promise<UpdateSessionEvent | null> {
        /*
        TODO split UpdateSessionEvent to improve completion
        createUpdateEvent({
            sessionUpdate: "" , <- completion of UpdateSessionEvent["sessionUpdate"]
            params: {}, <- quickfix to generate required fields (rest of)
        });
         */
        switch (notification.method) {
            case "item/agentMessage/delta":
                this.completeRetryIncidentOnTurnProgress();
                return await this.createTextEvent(notification.params);
            case "item/plan/delta":
                this.completeRetryIncidentOnTurnProgress();
                return this.createPlanDeltaEvent(notification.params);
            case "item/started":
                this.completeRetryIncidentOnTurnProgress();
                return await this.createItemEvent(notification.params);
            case "item/completed":
                this.completeRetryIncidentOnTurnProgress();
                return await this.completeItemEvent(notification.params);
            case "turn/plan/updated":
                this.completeRetryIncidentOnTurnProgress();
                return await this.updatePlan(notification.params);
            case "error":
                return await this.createErrorEvent(notification.params);
            case "turn/started":
                this.sessionState.currentTurnId = notification.params.turn.id;
                await this.flushPendingErrors();
                return null;
            case "turn/completed":
                await this.flushPendingPlanUpdates();
                this.clearPlanTurnState();
                this.sessionState.currentTurnId = null;
                return null;
            case "thread/tokenUsage/updated":
                return this.createUsageUpdate(notification.params);
            case "thread/name/updated":
                this.sessionState.sessionTitle = notification.params.threadName ?? null;
                this.sessionState.sessionTitleSource = notification.params.threadName == null
                    ? "unset"
                    : "explicit";
                return {
                    sessionUpdate: "session_info_update",
                    title: notification.params.threadName ?? null,
                };
            case "thread/status/changed":
                return this.createCodexSessionInfoUpdate({
                    threadStatus: notification.params.status,
                });
            case "thread/archived":
                return this.createCodexSessionInfoUpdate({
                    archived: true,
                });
            case "thread/unarchived":
                return this.createCodexSessionInfoUpdate({
                    archived: false,
                });
            case "thread/closed":
                return this.createCodexSessionInfoUpdate({
                    closed: true,
                });
            case "item/commandExecution/outputDelta":
                this.completeRetryIncidentOnTurnProgress();
                return this.createCommandOutputDeltaEvent(notification.params);
            case "item/mcpToolCall/progress":
                this.completeRetryIncidentOnTurnProgress();
                return this.createMcpToolProgressEvent(notification.params);
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "configWarning":
                return await this.createConfigWarningEvent(notification.params);
            case "warning":
                return this.createWarningEvent(notification.params);
            case "guardianWarning":
                return null;
            case "deprecationNotice":
                return this.createDeprecationNoticeEvent(notification.params);
            case "item/autoApprovalReview/started":
                return this.handleGuardianApprovalReviewStarted(notification.params);
            case "item/autoApprovalReview/completed":
                return this.handleGuardianApprovalReviewCompleted(notification.params);
            case "thread/compacted":
                return this.createContextCompactedEvent();
            case "item/reasoning/summaryTextDelta":
                this.completeRetryIncidentOnTurnProgress();
                return this.createReasoningDeltaEvent(notification.params);
            case "item/reasoning/textDelta":
                this.completeRetryIncidentOnTurnProgress();
                return this.createReasoningDeltaEvent(notification.params);
            case "item/reasoning/summaryPartAdded":
                this.completeRetryIncidentOnTurnProgress();
                return this.createReasoningSectionBreakEvent(notification.params);
            case "model/rerouted":
                return this.createModelReroutedEvent(notification.params);
            case "fuzzyFileSearch/sessionUpdated":
                return this.handleFuzzyFileSearchSessionUpdated(notification.params);
            case "fuzzyFileSearch/sessionCompleted":
                return this.handleFuzzyFileSearchSessionCompleted(notification.params);
            case "thread/goal/updated":
                return this.createThreadGoalUpdatedEvent(notification.params);
            case "thread/goal/cleared":
                return this.createThreadGoalClearedEvent(notification.params);
            case "item/commandExecution/terminalInteraction":
                return this.createTerminalInteractionEvent(notification.params);
            // ignored events
            case "thread/deleted":
            case "thread/reverted":
            case "thread/queue/changed":
            case "thread/environment/connected":
            case "thread/environment/disconnected":
            case "command/exec/outputDelta":
            case "hook/started":
            case "hook/completed":
            case "turn/diff/updated":
            case "turn/moderationMetadata":
            case "item/fileChange/outputDelta":
            case "item/fileChange/patchUpdated":
            case "account/updated":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
            case "serverRequest/resolved":
            case "model/verification":
            case "model/safetyBuffering/updated":
            case "windows/worldWritableWarning":
            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/transcript/delta":
            case "thread/realtime/transcript/done":
            case "thread/realtime/outputAudio/delta":
            case "thread/realtime/sdp":
            case "thread/realtime/error":
            case "thread/realtime/closed":
            case "windowsSandbox/setupCompleted":
            case "account/login/completed":
            case "skills/changed":
            case "mcpServer/oauthLogin/completed":
            case "externalAgentConfig/import/completed":
            case "rawResponseItem/completed":
            case "rawResponse/completed":
            case "thread/started":
            case "remoteControl/status/changed":
            case "app/list/updated":
            case "thread/settings/updated":
            case "externalAgentConfig/import/progress":
            case "process/outputDelta":
            case "process/exited":
                return null;
        }
    }

    private createCodexSessionInfoUpdate(codexMetadata: Record<string, unknown>): UpdateSessionEvent {
        return {
            sessionUpdate: "session_info_update",
            _meta: {
                codex: codexMetadata,
            },
        };
    }

    private async createTextEvent(event: AgentMessageDeltaNotification): Promise<UpdateSessionEvent> {
        const phase = this.agentMessagePhases.get(event.itemId) ?? null;
        return createAgentTextMessageChunk(event.delta, event.itemId, createCodexMessagePhaseMeta(phase));
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        if (this.supportsTypedSessionFailures) {
            return this.createSessionFailureUpdate(this.recordSessionNotice(...this.sessionNoticeContent(event.summary, event.details)));
        }
        const text = event.details ? `${event.summary}\n\n${event.details}` : event.summary;
        return createAgentTextMessageChunk(`Config warning: ${text}\n\n`);
    }

    /**
     * Unlike `warning` and `configWarning`, this notification was dropped outright, so there is no
     * legacy rendering to preserve. It is surfaced only to clients that negotiated typed records;
     * every other client keeps seeing exactly what it sees today, which is nothing.
     */
    private createDeprecationNoticeEvent(event: DeprecationNoticeNotification): UpdateSessionEvent | null {
        if (!this.supportsTypedSessionFailures) return null;
        return this.createSessionFailureUpdate(
            this.recordSessionNotice(...this.sessionNoticeContent(event.summary, event.details)),
        );
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        if (this.supportsTypedSessionFailures) {
            return this.createSessionFailureUpdate(this.recordSessionNotice(event.message));
        }
        return createAgentTextMessageChunk(`Warning: ${event.message}\n\n`);
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        return createAgentTextThoughtChunk(`Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`);
    }

    private createThreadGoalUpdatedEvent(event: ThreadGoalUpdatedNotification): UpdateSessionEvent | null {
        this.sessionState.goalRevision += 1;
        const goalSnapshot = toThreadGoalSnapshot(event.goal);
        if (sameThreadGoalSnapshot(this.sessionState.currentGoal, goalSnapshot)) {
            return null;
        }
        this.sessionState.currentGoal = goalSnapshot;

        return this.createGoalSessionInfoUpdate(goalSnapshot);
    }

    private createThreadGoalClearedEvent(_event: ThreadGoalClearedNotification): UpdateSessionEvent | null {
        this.sessionState.goalRevision += 1;
        if (this.sessionState.currentGoal === null) {
            return null;
        }
        this.sessionState.currentGoal = null;

        return this.createGoalSessionInfoUpdate(null);
    }

    private createGoalSessionInfoUpdate(goal: ThreadGoalSnapshot | null): UpdateSessionEvent {
        return {
            sessionUpdate: "session_info_update",
            _meta: {goal},
        };
    }

    private createReasoningDeltaEvent(
        event: ReasoningSummaryTextDeltaNotification | ReasoningTextDeltaNotification
    ): UpdateSessionEvent {
        this.seenReasoningDeltaItemIds.add(event.itemId);
        return this.createAgentThoughtEvent(event.delta, event.itemId);
    }

    private createPlanDeltaEvent(event: PlanDeltaNotification): null {
        if (event.delta.length === 0) {
            return null;
        }
        const text = this.planDeltaTextByItemId.get(event.itemId) ?? "";
        const updatedText = text + event.delta;
        this.planDeltaTextByItemId.set(event.itemId, updatedText);
        if (this.supportsPlanUpdates) {
            this.pendingPlanItemIds.add(event.itemId);
            this.schedulePlanUpdate();
        }
        return null;
    }

    private createReasoningSectionBreakEvent(event: ReasoningSummaryPartAddedNotification): UpdateSessionEvent {
        this.seenReasoningDeltaItemIds.add(event.itemId);
        return this.createAgentThoughtEvent("\n\n", event.itemId);
    }

    private createAgentThoughtEvent(text: string, messageId: string): UpdateSessionEvent {
        return createAgentTextThoughtChunk(text, messageId);
    }

    private async createItemEvent(event: ItemStartedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
                return await createFileChangeUpdate(event.item);
            case "commandExecution": {
                if (commandExecutionUsesTerminalOutput(event.item)) {
                    this.terminalCommandIds.add(event.item.id);
                } else {
                    this.terminalCommandIds.delete(event.item.id);
                    this.terminalCommandOutputIds.delete(event.item.id);
                }
                return await createCommandExecutionUpdate(event.item);
            }
            case "mcpToolCall":
                return await createMcpToolCallUpdate(event.item);
            case "dynamicToolCall":
                return await createDynamicToolCallUpdate(event.item);
            case "webSearch":
                return createWebSearchStartUpdate(event.item);
            case "imageView":
                this.emittedImageViewItems.add(event.item.id);
                return createImageViewUpdate(event.item);
            case "imageGeneration":
                this.activeImageGenerationItems.add(event.item.id);
                return createImageGenerationStartUpdate(event.item);
            case "collabAgentToolCall":
                return this.subagents.legacyCollaborationStarted(event.item);
            case "agentMessage":
                this.rememberAgentMessagePhase(event.item);
                return null;
            case "contextCompaction":
                return createContextCompactionStartUpdate(event.item);
            case "subAgentActivity":
                return this.subagents.legacyActivityStarted(event.item);
            case "sleep":
            case "userMessage":
            case "hookPrompt":
            case "reasoning":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "plan":
                return null;
        }
    }

    private async completeItemEvent(event: ItemCompletedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
            case "dynamicToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed",
                }
            case "mcpToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed",
                    rawInput: createMcpRawInput(event.item.server, event.item.tool, event.item.arguments),
                    rawOutput: createMcpRawOutput(event.item.result, event.item.error),
                }
            case "commandExecution":
                return this.completeCommandExecutionEvent(event.item);
            case "imageView":
                if (this.emittedImageViewItems.delete(event.item.id)) {
                    return null;
                }
                return createImageViewUpdate(event.item);
            case "imageGeneration":
                if (this.activeImageGenerationItems.delete(event.item.id)) {
                    return createImageGenerationCompleteUpdate(event.item);
                }
                return createImageGenerationUpdate(event.item, { terminalStatus: true });
            case "reasoning":
                if (this.seenReasoningDeltaItemIds.delete(event.item.id)) {
                    return null;
                }
                return this.createCompletedReasoningEvent(event.item);
            case "webSearch":
                return createWebSearchCompleteUpdate(event.item);
            case "collabAgentToolCall":
                return this.subagents.legacyCollaborationCompleted(event.item);
            case "agentMessage":
                this.rememberAgentMessagePhase(event.item);
                return null;
            case "plan": {
                const deltaText = this.planDeltaTextByItemId.get(event.item.id) ?? "";
                return await this.createCompletedPlanEvent(event.item, deltaText);
            }
            case "exitedReviewMode":
                return this.createExitedReviewModeEvent(event.item);
            case "contextCompaction":
                return createContextCompactionCompleteUpdate(event.item);
            //ignored types
            case "subAgentActivity":
                return this.subagents.legacyActivityCompleted(event.item);
            case "sleep":
            case "userMessage":
            case "hookPrompt":
            case "enteredReviewMode":
                return null;

        }
    }

    private rememberAgentMessagePhase(item: ThreadItem & { type: "agentMessage" }): void {
        this.agentMessagePhases.set(item.id, item.phase);
    }

    private createCompletedReasoningEvent(item: ThreadItem & { type: "reasoning" }): UpdateSessionEvent | null {
        const parts = item.summary.length > 0 ? item.summary : item.content;
        const text = parts.filter(part => part.length > 0).join("\n\n");
        if (text.length === 0) {
            return null;
        }
        return this.createAgentThoughtEvent(text, item.id);
    }

    private async createCompletedPlanEvent(
        item: ThreadItem & { type: "plan" },
        deltaText: string,
    ): Promise<UpdateSessionEvent | null> {
        const text = item.text.length > 0 ? item.text : deltaText;
        this.pendingPlanItemIds.delete(item.id);
        if (this.pendingPlanItemIds.size === 0) {
            this.cancelPlanUpdateTimer();
        }
        this.planDeltaTextByItemId.delete(item.id);
        if (text.length === 0) {
            return null;
        }
        this.completedPlan = {itemId: item.id, text};
        if (this.supportsPlanUpdates) {
            await this.enqueuePlanSnapshot(item.id, text);
            return null;
        }
        return this.createPlanTextEvent(text, item.id);
    }

    private schedulePlanUpdate(): void {
        if (this.disposed || this.planUpdateTimer !== null) return;
        this.planUpdateTimer = setTimeout(() => {
            this.planUpdateTimer = null;
            void this.flushPendingPlanUpdates().catch(error => {
                logger.error("Failed to flush throttled plan updates", error);
            });
        }, CodexEventHandler.PLAN_UPDATE_INTERVAL_MS);
    }

    private cancelPlanUpdateTimer(): void {
        if (this.planUpdateTimer === null) return;
        clearTimeout(this.planUpdateTimer);
        this.planUpdateTimer = null;
    }

    private enqueuePlanSnapshot(itemId: string, text: string): Promise<void> {
        const send = async () => {
            if (this.lastEmittedPlanTextByItemId.get(itemId) === text) return;
            await this.session.update(this.createPlanUpdateEvent(text, itemId));
            this.lastEmittedPlanTextByItemId.set(itemId, text);
        };
        const result = this.planUpdateChain.then(send);
        this.planUpdateChain = result.catch(() => {});
        return result;
    }

    private clearPlanTurnState(): void {
        this.cancelPlanUpdateTimer();
        this.pendingPlanItemIds.clear();
        this.planDeltaTextByItemId.clear();
        this.lastEmittedPlanTextByItemId.clear();
    }

    private createPlanUpdateEvent(text: string, planId: string): UpdateSessionEvent {
        return {
            sessionUpdate: "plan_update",
            plan: {
                type: "markdown",
                planId,
                content: text,
            },
        };
    }

    private createPlanTextEvent(text: string, messageId: string): UpdateSessionEvent {
        return createAgentTextMessageChunk(
            text,
            messageId,
            createCodexMessagePhaseMeta("final_answer"),
        );
    }

    private createExitedReviewModeEvent(item: ThreadItem & { type: "exitedReviewMode" }): UpdateSessionEvent | null {
        const text = item.review.trim();
        if (text.length === 0) {
            return null;
        }
        return createAgentTextMessageChunk(text);
    }

    private createContextCompactedEvent(): UpdateSessionEvent {
        return createAgentTextMessageChunk("*Context compacted to fit the model's context window.*\n\n");
    }

    private createCommandOutputDeltaEvent(event: CommandExecutionOutputDeltaNotification): UpdateSessionEvent {
        if (this.terminalCommandIds.has(event.itemId) && event.delta.length > 0) {
            this.terminalCommandOutputIds.add(event.itemId);
        }
        return this.createCommandOutputEvent(event.itemId, event.delta, this.commandOutputMode(event.itemId));
    }

    private createCommandOutputEvent(
        itemId: string,
        data: string,
        terminalOutputMode: TerminalOutputMode
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: itemId,
            _meta: createTerminalOutputMeta(terminalOutputMode, itemId, data),
        }
    }

    private createTerminalInteractionEvent(event: TerminalInteractionNotification): UpdateSessionEvent {
        return this.createCommandOutputDeltaEvent({
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            delta: `\n${event.stdin}\n`,
        });
    }

    private commandOutputMode(itemId: string): TerminalOutputMode {
        if (this.sessionState.terminalOutputMode === "terminal_output" && !this.terminalCommandIds.has(itemId)) {
            return "terminal_output_delta";
        }
        return this.sessionState.terminalOutputMode;
    }

    private createMcpToolProgressEvent(event: { itemId: string, message: string }): UpdateSessionEvent {
        const logDelta = event.message.trim();
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: event.itemId,
            _meta: {
                mcp_output_delta: {
                    data: logDelta,
                }
            }
        };
    }

    static createMcpStartupUpdates(event: McpStartupCompleteEvent): UpdateSessionEvent[] {
        const failedUpdates = event.failed.map((server: McpStartupCompleteEvent["failed"][number]) => this.createMcpStartupToolCallUpdate(
            server.server,
            `[codex-acp forwarded startup error] MCP server \`${server.server}\` failed to start: ${server.error}`
        ));
        const cancelledUpdates = event.cancelled.map((server: McpStartupCompleteEvent["cancelled"][number]) => this.createMcpStartupToolCallUpdate(
            server,
            `[codex-acp forwarded startup error] MCP server \`${server}\` startup was cancelled.`
        ));

        return [...failedUpdates, ...cancelledUpdates];
    }

    private static createMcpStartupToolCallUpdate(serverName: string, message: string): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: this.getMcpStartupToolCallId(serverName),
            kind: "other",
            title: `mcp__${serverName}__startup`,
            status: "failed",
            content: [{
                type: "content",
                content: {
                    type: "text",
                    text: message,
                },
            }],
        };
    }

    private static getMcpStartupToolCallId(serverName: string): string {
        return `mcp_startup.${encodeURIComponent(serverName)}`;
    }

    private completeCommandExecutionEvent(item: ThreadItem & { "type": "commandExecution" }): UpdateSessionEvent {
        const update: UpdateSessionEvent = {
            sessionUpdate: "tool_call_update",
            toolCallId: item.id,
            status: item.status === "completed" ? "completed" : "failed",
            rawOutput: {
                formatted_output: item.aggregatedOutput ?? "",
                exit_code: item.exitCode
            },
        };

        const commandHadTerminal = this.terminalCommandIds.delete(item.id);
        const commandHadOutput = this.terminalCommandOutputIds.delete(item.id);
        if (!commandHadTerminal) {
            return update;
        }
        const terminalMeta: Record<string, unknown> = {};
        if (!commandHadOutput && item.aggregatedOutput) {
            Object.assign(
                terminalMeta,
                createTerminalOutputMeta(this.sessionState.terminalOutputMode, item.id, item.aggregatedOutput)
            );
        }
        terminalMeta["terminal_exit"] = {
            exit_code: item.exitCode,
            signal: null,
            terminal_id: item.id
        };
        return {
            ...update,
            _meta: terminalMeta,
        };
    }

    private async updatePlan(event: TurnPlanUpdatedNotification): Promise<UpdateSessionEvent> {
        const plan: PlanEntry[] = event.plan.map(value => ({
                status: value.status == "inProgress" ? "in_progress" : value.status,
                content: value.step,
                priority: "medium"
            })
        );
        return {
            sessionUpdate: "plan",
            entries: plan,
        }
    }

    private async createErrorEvent(params: ErrorNotification): Promise<UpdateSessionEvent | null> {
        const error = params.error.codexErrorInfo;
        if (this.sessionState.currentTurnId === null) {
            this.pendingErrors.push(params);
            logger.log("Buffered app-server error until the active turn is known", {
                sessionId: this.sessionState.sessionId,
                turnId: params.turnId,
                willRetry: params.willRetry,
            });
            return null;
        }
        if (params.turnId !== this.sessionState.currentTurnId) {
            if (this.supportsTypedSessionFailures) {
                const failure = params.willRetry
                    ? this.recordRetryWarning(params)
                    : this.recordSessionFailure(
                        this.sessionFailureKind(params.error.codexErrorInfo),
                        params.turnId,
                        "error",
                        params.error.message,
                    );
                return this.createSessionFailureUpdate(failure);
            }
            return this.createCodexSessionInfoUpdate({
                error: {...params.error, turnId: params.turnId, willRetry: params.willRetry},
            });
        }
        if (params.willRetry) {
            if (this.supportsTypedSessionFailures) {
                return this.createSessionFailureUpdate(this.recordRetryWarning(params));
            }
            return this.createCodexSessionInfoUpdate({
                error: {
                    ...params.error,
                    turnId: params.turnId,
                    willRetry: true,
                },
            });
        }
        if (this.supportsTypedSessionFailures) {
            // app-server guarantees willRetry=false interrupts this turn; the terminal failure is
            // returned once on PromptResponse._meta rather than duplicated as a session update.
            this.recordTypedSessionFailure(params);
            return null;
        }
        if (error === "usageLimitExceeded") {
            this.failure = RequestError.internalError(
                this.createTurnErrorData(params.error),
            );
        } else if (this.isAuthenticationRequiredError(error)) {
            this.failure = this.sessionState.authConfigured
                ? RequestError.internalError(this.createTurnErrorData(params.error))
                : RequestError.authRequired(this.createTurnErrorData(params.error), params.error.message);
        }
        return createAgentTextMessageChunk(`${params.error.message}\n\n`);
    }

    private recordTypedSessionFailure(params: ErrorNotification): void {
        const kind = this.sessionFailureKind(params.error.codexErrorInfo);
        this.recordSessionFailure(kind, params.turnId, "error", params.error.message);
    }

    private recordSessionFailure(
        kind: CodexFailureKind,
        turnId: string | undefined,
        severity: "warning" | "error",
        title: string,
        actionsOverride?: SessionFailureAction[],
        attributeToTurn = true,
    ): NonNullable<SessionState["sessionFailure"]> {
        const policy = SESSION_FAILURE_POLICY[kind];
        const scope = turnId ?? this.sessionState.sessionId;
        const id = this.activeFailureIdByScope.get(scope)
            ?? this.allocateFailureId(scope, turnId);
        const previous = this.failuresById.get(id);
        const failure: NonNullable<SessionState["sessionFailure"]> = {
            id,
            revision: nextSessionFailureRevision(previous, id),
            category: policy.category,
            severity,
            title,
            actions: actionsOverride ?? policy.actions,
        };
        this.failuresById.set(id, failure);
        this.failureTurnIdById.set(id, attributeToTurn ? turnId : undefined);
        this.activeFailureIdByScope.set(scope, id);
        this.sessionState.sessionFailure = failure;
        this.lastSessionNotice = undefined;
        return failure;
    }

    private allocateFailureId(scope: string, turnId: string | undefined): string {
        if (turnId !== undefined && !this.allocatedFailureScopes.has(scope)) {
            this.allocatedFailureScopes.add(scope);
            return `${turnId}:error`;
        }
        this.allocatedFailureScopes.add(scope);
        return `${scope}:error:${this.sessionFailureEpoch}:${this.nextNoticeId++}`;
    }

    /**
     * A retry warning remains the active incident until Codex produces turn content again. That content is
     * the only positive signal available from app-server that the turn recovered; a later error then starts
     * a new incident instead of overwriting the historical reconnect entry. Terminal errors remain active so
     * duplicate late notifications cannot append duplicate transcript rows.
     */
    private completeRetryIncidentOnTurnProgress(): void {
        const turnId = this.sessionState.currentTurnId;
        if (turnId === null) return;
        const activeId = this.activeFailureIdByScope.get(turnId);
        if (activeId === undefined || this.failuresById.get(activeId)?.severity !== "warning") return;
        this.activeFailureIdByScope.delete(turnId);
        if (this.sessionState.sessionFailure?.id === activeId) {
            delete this.sessionState.sessionFailure;
        }
    }

    private recordRetryWarning(params: ErrorNotification, attributeToTurn = true): SessionFailure {
        const kind = this.sessionFailureKind(params.error.codexErrorInfo);
        return this.recordSessionFailure(
            kind,
            params.turnId,
            "warning",
            params.error.message,
            [],
            attributeToTurn,
        );
    }

    private recordSessionNotice(title: string, details?: string): SessionFailure {
        const key = `${title}\u0000${details ?? ""}`;
        const previous = this.lastSessionNotice?.key === key
            ? this.lastSessionNotice.failure
            : undefined;
        const id = previous?.id
            ?? `${this.sessionState.sessionId}:notice:${this.sessionFailureEpoch}:${this.nextNoticeId++}`;
        const notice: SessionFailure = {
            id,
            revision: nextSessionFailureRevision(previous, id),
            category: "unknown",
            severity: "warning",
            title,
            ...(details === undefined ? {} : {details}),
            actions: [],
        };
        this.lastSessionNotice = {key, failure: notice};
        return notice;
    }

    private sessionNoticeContent(summary: string, details: string | null): [title: string, details?: string] {
        if (details === null) return [summary];
        const combinedTitle = `${summary} — ${details}`;
        return combinedTitle.length <= MAX_SESSION_FAILURE_TITLE_LENGTH
            ? [combinedTitle]
            : [summary, details];
    }

    private createSessionFailureMeta(
        failure: NonNullable<SessionState["sessionFailure"]>,
    ): Record<string, unknown> {
        return {
            [JETBRAINS_META_KEY]: {
                [AIR_META_KEY]: {
                    [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                    [AIR_SESSION_FAILURE_KEY]: failure,
                },
            },
        };
    }

    private createSessionFailureUpdate(
        failure: NonNullable<SessionState["sessionFailure"]>,
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "session_info_update",
            _meta: this.createSessionFailureMeta(failure),
        };
    }

    private sessionFailureKind(error: CodexErrorInfo | null): CodexFailureKind {
        if (this.isAuthenticationRequiredError(error)) return "auth_required";
        if (this.getHttpStatusCode(error) === 429) return "rate_limited";
        if (typeof error === "string") {
            return STRING_CODEX_ERROR_CATEGORIES[error] ?? "provider_error";
        }
        if (error !== null) {
            for (const kind of Object.keys(STRUCTURED_CODEX_ERROR_CATEGORIES) as StructuredCodexErrorKind[]) {
                if (kind in error) {
                    return STRUCTURED_CODEX_ERROR_CATEGORIES[kind] ?? "provider_error";
                }
            }
        }
        return "provider_error";
    }

    private isAuthenticationRequiredError(error: CodexErrorInfo | null): boolean {
        return error === "unauthorized" || this.getHttpStatusCode(error) === 401;
    }

    private getHttpStatusCode(error: CodexErrorInfo | null): number | null {
        if (error === null || typeof error !== "object") return null;
        const details: unknown = Object.values(error)[0];
        if (details === null || typeof details !== "object" || !("httpStatusCode" in details)) return null;
        return typeof details.httpStatusCode === "number" ? details.httpStatusCode : null;
    }

    private createTurnErrorData(error: ErrorNotification["error"]): {
        message: string;
        codexErrorInfo?: CodexErrorInfo;
        additionalDetails?: string;
    } {
        const data: {
            message: string;
            codexErrorInfo?: CodexErrorInfo;
            additionalDetails?: string;
        } = {
            message: error.additionalDetails ?? error.message,
        };
        if (error.codexErrorInfo !== null) {
            data.codexErrorInfo = error.codexErrorInfo;
        }
        if (error.additionalDetails !== null) {
            data.additionalDetails = error.additionalDetails;
        }
        return data;
    }

    private handleTokenUsageUpdated(params: ThreadTokenUsageUpdatedNotification): void {
        this.sessionState.lastTokenUsage = toTokenCount(params.tokenUsage.last);
        this.sessionState.totalTokenUsage = toTokenCount(params.tokenUsage.total);
        this.sessionState.modelContextWindow = params.tokenUsage.modelContextWindow;
    }

    private createUsageUpdate(params: ThreadTokenUsageUpdatedNotification): UpdateSessionEvent | null {
        this.handleTokenUsageUpdated(params);

        const used = this.sessionState.lastTokenUsage?.totalTokens;
        const size = this.sessionState.modelContextWindow;
        if (used == null || size == null || size <= 0) {
            return null;
        }

        return {
            sessionUpdate: "usage_update",
            used,
            size,
        };
    }

    private handleRateLimitsUpdated(params: AccountRateLimitsUpdatedNotification): void {
        if (!this.sessionState.rateLimits) {
            this.sessionState.rateLimits = new Map();
        }
        const limitId = params.rateLimits.limitId ?? params.rateLimits.limitName ?? "unknown";
        this.sessionState.rateLimits.set(limitId, {
            limitId: limitId,
            limitName: params.rateLimits.limitName ?? limitId,
            snapshot: params.rateLimits,
        });
    }

    private handleFuzzyFileSearchSessionUpdated(
        params: FuzzyFileSearchSessionUpdatedNotification
    ): UpdateSessionEvent {
        const toolCallId = fuzzyFileSearchToolCallId(params.sessionId);
        const started = !this.activeFuzzyFileSearchSessions.has(toolCallId);
        this.activeFuzzyFileSearchSessions.add(toolCallId);
        return createFuzzyFileSearchStartOrUpdate(params, started);
    }

    private handleFuzzyFileSearchSessionCompleted(
        params: FuzzyFileSearchSessionCompletedNotification
    ): UpdateSessionEvent {
        const toolCallId = fuzzyFileSearchToolCallId(params.sessionId);
        this.activeFuzzyFileSearchSessions.delete(toolCallId);
        return createFuzzyFileSearchComplete(params);
    }

    private handleGuardianApprovalReviewStarted(
        params: ItemGuardianApprovalReviewStartedNotification
    ): UpdateSessionEvent {
        if (this.activeGuardianApprovalReviews.has(params.reviewId)) {
            return createGuardianApprovalReviewToolCallUpdate(params);
        }
        this.activeGuardianApprovalReviews.add(params.reviewId);
        return createGuardianApprovalReviewToolCall(params);
    }

    private handleGuardianApprovalReviewCompleted(
        params: ItemGuardianApprovalReviewCompletedNotification
    ): UpdateSessionEvent {
        if (this.activeGuardianApprovalReviews.delete(params.reviewId)) {
            return createGuardianApprovalReviewToolCallUpdate(params);
        }
        return createGuardianApprovalReviewToolCall(params);
    }
}
