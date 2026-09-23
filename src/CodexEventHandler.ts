import type {
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
    AccountUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    ConfigWarningNotification,
    DeprecationNoticeNotification,
    ErrorNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    ThreadItem,
    ModelReroutedNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    ThreadGoalClearedNotification,
    ThreadGoalUpdatedNotification,
    ThreadTokenUsageUpdatedNotification,
    Turn,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import {toTokenCount} from "./TokenCount";
import { stripShellPrefix } from "./CommandUtils";
import {AcpToolCallRenderer} from "./tool-calls/AcpToolCallRenderer";
import type {ToolFacts} from "./tool-calls/ToolFacts";
import {CommandReporter} from "./tool-calls/reporters/CommandReporter";
import {CompactionReporter} from "./tool-calls/reporters/CompactionReporter";
import {DynamicToolReporter} from "./tool-calls/reporters/DynamicToolReporter";
import {FileChangeReporter} from "./tool-calls/reporters/FileChangeReporter";
import {FuzzySearchReporter} from "./tool-calls/reporters/FuzzySearchReporter";
import {GuardianReporter} from "./tool-calls/reporters/GuardianReporter";
import {ImageGenerationReporter} from "./tool-calls/reporters/ImageGenerationReporter";
import {ImageViewReporter} from "./tool-calls/reporters/ImageViewReporter";
import {McpToolReporter} from "./tool-calls/reporters/McpToolReporter";
import {WebSearchReporter} from "./tool-calls/reporters/WebSearchReporter";
import {CodexPlanStream} from "./CodexPlanStream";
import {
    createMessagePhaseMeta,
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
} from "./ContentChunks";
import {sameThreadGoalSnapshot, type ThreadGoalSnapshot, toThreadGoalSnapshot} from "./ThreadGoalSnapshot";
import {logger} from "./Logger";
import {randomUUID} from "node:crypto";
import {
    AIR_EXTENSION_VERSION,
    AIR_EXTENSION_VERSION_KEY,
    AIR_GOAL_KEY,
    AIR_META_KEY,
    AIR_SESSION_FAILURE_KEY,
    JETBRAINS_META_KEY,
    withAirMeta,
} from "./AirExtension";
import {CodexSubagentEventRouter} from "./subagents/CodexSubagentEventRouter";
import type {SubagentState} from "./subagents/AcpSubagents";
import {mergeRateLimitSnapshot} from "./RateLimitsMap";
import {AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES} from "./AgentFileChangeReport";
import {createSessionNotice} from "./SessionNotice";

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
    rateLimitExceeded: "rate_limited",
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

    private readonly sessionState: SessionState;
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
    private readonly activeImageGenerationItems = new Set<string>();
    private readonly emittedImageViewItems = new Set<string>();
    private readonly session: ACPSessionConnection;
    private readonly renderer: AcpToolCallRenderer;
    private readonly commands = new CommandReporter();
    private readonly fuzzySearches = new FuzzySearchReporter();
    private readonly guardianReviews = new GuardianReporter();
    private readonly plans: CodexPlanStream;
    private disposed = false;
    private readonly seenReasoningDeltaItemIds = new Set<string>();
    private readonly agentMessagePhases = new Map<string, string | null>();
    private readonly turnDiffs = new Map<string, string>();
    private readonly oversizedTurnDiffs = new Set<string>();
    private readonly collectTurnDiffs: boolean;
    private readonly subagents: CodexSubagentEventRouter;
    /** Connection-level `authStatus` sink; the app-server account push feeds it. */
    private readonly onAccountUpdated: ((notification: AccountUpdatedNotification) => void) | undefined;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        supportsTypedSessionFailures = false,
        sessionFailureEpoch: string = randomUUID(),
        subagents: CodexSubagentEventRouter = new CodexSubagentEventRouter(
            sessionState.sessionId,
            false,
            new ACPSessionConnection(connection, sessionState.sessionId),
        ),
        onAccountUpdated?: (notification: AccountUpdatedNotification) => void,
        collectTurnDiffs = false,
        private readonly supportsCompaction = false,
        private readonly supportsNotices = false,
    ) {
        this.onAccountUpdated = onAccountUpdated;
        this.sessionState = sessionState;
        this.supportsTypedSessionFailures = supportsTypedSessionFailures;
        this.sessionFailureEpoch = sessionFailureEpoch;
        this.session = new ACPSessionConnection(connection, sessionState.sessionId);
        this.renderer = new AcpToolCallRenderer(sessionState.clientCapabilities);
        this.plans = new CodexPlanStream(this.session, sessionState.clientCapabilities);
        this.subagents = subagents;
        this.collectTurnDiffs = collectTurnDiffs;
        if (sessionState.sessionFailure !== undefined) {
            this.failuresById.set(sessionState.sessionFailure.id, sessionState.sessionFailure);
        }
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    getTurnDiff(turnId: string): string {
        return this.turnDiffs.get(turnId) ?? "";
    }

    isTurnDiffOversized(turnId: string): boolean {
        return this.oversizedTurnDiffs.has(turnId);
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
        await this.finishCompactionsForNotification(notification);
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
            misalignment: null,
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
        await this.finishCompactionsForNotification(notification);
        const closingChildren = this.subagents.closingChildSessions(notification);
        for (const child of closingChildren) {
            await this.finishOutstandingCompactions(
                child.state === "cancelled" ? "cancelled" : "failed",
                child.sessionId,
            );
            await this.sessionState.asyncTasks.reconcile(child.threadId, child.sessionId);
        }
        const handledBySubagents = await this.subagents.handle(notification);
        for (const buffered of this.subagents.takeBufferedNotifications()) {
            await this.handleNotification(buffered);
        }
        const ignoredBySubagents = !handledBySubagents && this.subagents.shouldIgnore(notification);
        let updateEvent: UpdateSessionEvent | null | undefined;
        if (!handledBySubagents
            && !ignoredBySubagents
            && notification.method === "item/started"
            && notification.params.item.type === "commandExecution") {
            updateEvent = await this.createUpdateEvent(notification);
        }
        if (!handledBySubagents) {
            await this.sessionState.asyncTasks.handleNotification(
                notification,
                this.subagents.notificationSessionId(notification),
                toolCallTitle(updateEvent),
            );
        }
        if (handledBySubagents) return;
        if (ignoredBySubagents) return;
        if (updateEvent === undefined) updateEvent = await this.createUpdateEvent(notification);
        if (updateEvent) {
            await this.session.update(updateEvent, this.subagents.notificationSessionId(notification));
        }
    }

    async waitForNativeSubagentSession(childThreadId: string): Promise<string | null> {
        return await this.subagents.waitForMaterializedSession(childThreadId);
    }

    async waitForNativeSubagents(signal: AbortSignal): Promise<void> {
        if (await this.subagents.wait(signal) === "timed_out") {
            await this.finishOutstandingNativeSubagents("failed");
        }
    }

    async finishOutstandingNativeSubagents(state: SubagentState): Promise<void> {
        await this.finishOutstandingCompactions(state === "cancelled" ? "cancelled" : "failed");
        await this.subagents.finishOutstanding(state);
    }

    async finishOutstandingCompactions(status: "failed" | "cancelled", sessionId?: string): Promise<void> {
        if (!this.supportsCompaction) return;
        for (const {sessionId: targetSessionId, update} of this.sessionState.compactions.finishOutstanding(status, sessionId)) {
            await this.session.update(update, targetSessionId);
        }
    }

    private async finishCompactionsForNotification(notification: ServerNotification): Promise<void> {
        if (!this.supportsCompaction) return;
        let updates: UpdateSessionEvent[];
        const sessionId = this.subagents.notificationSessionId(notification);
        if (notification.method === "turn/completed") {
            const turn = notification.params.turn;
            if (turn.status === "inProgress") return;
            updates = this.sessionState.compactions.finishTurn(
                sessionId,
                turn.id,
                turn.status === "interrupted" ? "cancelled" : "failed",
                turn.error?.message ?? "Codex ended the turn before compaction completed.",
            );
        } else if (notification.method === "error" && !notification.params.willRetry) {
            updates = this.sessionState.compactions.finishTurn(
                sessionId,
                notification.params.turnId,
                "failed",
                notification.params.error.message,
            );
        } else {
            return;
        }
        for (const update of updates) await this.session.update(update, sessionId);
    }

    async flushPendingPlanUpdates(): Promise<void> {
        await this.plans.flush();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.plans.dispose();
        if (this.pendingErrors.length > 0) {
            logger.log("Discarding app-server errors that arrived before a turn started", {
                sessionId: this.sessionState.sessionId,
                count: this.pendingErrors.length,
                turnIds: this.pendingErrors.map(error => error.turnId),
            });
            this.pendingErrors.splice(0);
        }
        this.disposed = true;
        this.turnDiffs.clear();
        this.oversizedTurnDiffs.clear();
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
                return this.plans.delta(notification.params.itemId, notification.params.delta);
            case "item/started":
                this.completeRetryIncidentOnTurnProgress();
                return await this.createItemEvent(notification.params);
            case "item/completed":
                this.completeRetryIncidentOnTurnProgress();
                return await this.completeItemEvent(notification.params);
            case "turn/plan/updated":
                this.completeRetryIncidentOnTurnProgress();
                return await this.updatePlan(notification.params);
            case "turn/diff/updated":
                if (notification.params.threadId === this.sessionState.sessionId) {
                    this.completeRetryIncidentOnTurnProgress();
                    if (!this.disposed && this.collectTurnDiffs) {
                        if (Buffer.byteLength(notification.params.diff, "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES) {
                            this.turnDiffs.delete(notification.params.turnId);
                            this.oversizedTurnDiffs.add(notification.params.turnId);
                        } else {
                            // Codex 0.154 emits an empty snapshot when its tracker transitions
                            // from a non-empty aggregate to no diff, which clears stale state here.
                            this.oversizedTurnDiffs.delete(notification.params.turnId);
                            this.turnDiffs.set(notification.params.turnId, notification.params.diff);
                        }
                    }
                }
                return null;
            case "error":
                return await this.createErrorEvent(notification.params);
            case "turn/started":
                this.sessionState.currentTurnId = notification.params.turn.id;
                await this.flushPendingErrors();
                return null;
            case "turn/completed":
                await this.plans.flush();
                this.plans.clearTurn();
                this.sessionState.currentTurnId = null;
                this.sessionState.toolCallReports.releaseOpen(this.subagents.notificationSessionId(notification));
                return null;
            case "thread/tokenUsage/updated":
                return this.createUsageUpdate(notification.params);
            case "thread/name/updated":
                this.sessionState.sessionTitle = notification.params.threadName ?? null;
                this.sessionState.sessionTitleSource = notification.params.threadName == null
                    ? "unset"
                    : "explicit";
                this.sessionState.titleGen?.observeRename();
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
                return this.renderFacts(this.commands.outputDelta(notification.params.itemId, notification.params.delta));
            case "item/mcpToolCall/progress":
                this.completeRetryIncidentOnTurnProgress();
                // AIR does not show MCP progress.
                if (this.renderer.capabilities.airClient) return null;
                return this.renderer.render(McpToolReporter.progress(
                    notification.params.itemId,
                    notification.params.message,
                ));
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "account/updated":
                this.onAccountUpdated?.(notification.params);
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
                return this.renderer.render(this.guardianReviews.started(notification.params));
            case "item/autoApprovalReview/completed":
                return this.renderer.render(this.guardianReviews.completed(notification.params));
            case "thread/compacted":
                return this.supportsCompaction
                    ? this.sessionState.compactions.completeLegacy(
                        this.subagents.notificationSessionId(notification), notification.params.turnId,
                    )
                    : this.createContextCompactedEvent();
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
                return this.renderer.render(this.fuzzySearches.updated(notification.params));
            case "fuzzyFileSearch/sessionCompleted":
                return this.renderer.render(this.fuzzySearches.completed(notification.params));
            case "thread/goal/updated":
                return this.createThreadGoalUpdatedEvent(notification.params);
            case "thread/goal/cleared":
                return this.createThreadGoalClearedEvent(notification.params);
            case "item/commandExecution/terminalInteraction":
                return this.renderFacts(this.commands.terminalInput(
                    notification.params.itemId,
                    notification.params.stdin,
                ));
            case "thread/attachment/updated":
                // Persisted attachment metadata has no ACP session update counterpart.
                return null;
            // ignored events
            case "thread/deleted":
            case "thread/reverted":
            case "thread/queue/changed":
            case "project/changed":
            case "thread/project/updated":
            case "thread/environment/connected":
            case "thread/environment/disconnected":
            case "command/exec/outputDelta":
            case "hook/started":
            case "hook/completed":
            case "turn/moderationMetadata":
            case "item/fileChange/outputDelta":
            case "item/fileChange/patchUpdated":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
            case "mcpServer/event/stream/notification":
            case "serverRequest/resolved":
            case "model/verification":
            case "modelProvider/authRecoveryStarted":
            case "modelProvider/authRecoveryCompleted":
            case "model/safetyBuffering/updated":
            case "windows/worldWritableWarning":
            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/item/started":
            case "thread/realtime/item/transcript/delta":
            case "thread/realtime/item/completed":
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
            case "autoApprovalReview/strictReviewRequired":
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
        const meta = createMessagePhaseMeta(phase, this.sessionState.clientCapabilities.airClient);
        return createAgentTextMessageChunk(event.delta, event.itemId, meta);
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        if (this.supportsNotices) {
            return createSessionNotice("warning", event.summary.trim() || "Configuration warning", event.details);
        }
        if (this.supportsTypedSessionFailures) {
            return this.createSessionFailureUpdate(this.recordSessionNotice(...this.sessionNoticeContent(event.summary, event.details)));
        }
        const text = event.details ? `${event.summary}\n\n${event.details}` : event.summary;
        return createAgentTextMessageChunk(`Config warning: ${text}\n\n`);
    }

    private createDeprecationNoticeEvent(event: DeprecationNoticeNotification): UpdateSessionEvent | null {
        if (this.supportsNotices) {
            return createSessionNotice("warning", event.summary.trim() || "Deprecated configuration", event.details);
        }
        // Legacy clients without typed failures have never received deprecation notices.
        if (!this.supportsTypedSessionFailures) return null;
        return this.createSessionFailureUpdate(
            this.recordSessionNotice(...this.sessionNoticeContent(event.summary, event.details)),
        );
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        if (this.supportsNotices) {
            return createSessionNotice("warning", event.message.trim() || "Codex warning");
        }
        if (this.supportsTypedSessionFailures) {
            return this.createSessionFailureUpdate(this.recordSessionNotice(event.message));
        }
        return createAgentTextMessageChunk(`Warning: ${event.message}\n\n`);
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        if (!this.supportsNotices) {
            return createAgentTextThoughtChunk(`Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`);
        }
        return createSessionNotice(
            "info",
            "Model rerouted",
            `Switched from ${event.fromModel} to ${event.toModel} (${event.reason}).`,
        );
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

    /** Only AIR gets the goal. The update carries nothing else, so another client gets no update. */
    private createGoalSessionInfoUpdate(goal: ThreadGoalSnapshot | null): UpdateSessionEvent | null {
        if (!this.sessionState.clientCapabilities.airClient) return null;
        return {
            sessionUpdate: "session_info_update",
            _meta: withAirMeta(undefined, AIR_GOAL_KEY, goal),
        };
    }

    private createReasoningDeltaEvent(
        event: ReasoningSummaryTextDeltaNotification | ReasoningTextDeltaNotification
    ): UpdateSessionEvent {
        this.seenReasoningDeltaItemIds.add(event.itemId);
        return this.createAgentThoughtEvent(event.delta, event.itemId);
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
                return this.renderer.render(await FileChangeReporter.started(
                    event.item,
                    this.sessionState.clientCapabilities.air.diffPatch,
                ));
            case "commandExecution":
                return this.renderer.render(this.commands.started(event.item));
            case "mcpToolCall":
                return this.renderer.render(McpToolReporter.started(event.item));
            case "dynamicToolCall":
                return this.renderer.render(DynamicToolReporter.started(event.item));
            case "webSearch":
                return this.renderer.render(WebSearchReporter.started(event.item));
            case "imageView":
                this.emittedImageViewItems.add(event.item.id);
                return this.renderer.render(ImageViewReporter.viewed(event.item));
            case "imageGeneration":
                this.activeImageGenerationItems.add(event.item.id);
                return this.renderer.render(ImageGenerationReporter.started(event.item));
            case "collabAgentToolCall":
                return this.renderer.render(this.subagents.legacyCollaborationStarted(event.item));
            case "agentMessage":
                this.rememberAgentMessagePhase(event.item);
                return null;
            case "contextCompaction":
                return this.supportsCompaction
                    ? this.sessionState.compactions.start(
                        this.subagents.notificationSessionId({method: "item/started", params: event}),
                        event.turnId, event.item.id,
                    )
                    : this.renderer.render(CompactionReporter.started(event.item));
            case "subAgentActivity":
                return this.renderer.render(this.subagents.legacyActivityStarted(event.item));
            case "sleep":
            case "functionCallOutput":
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
                return this.renderer.render(FileChangeReporter.completed(event.item));
            case "dynamicToolCall":
                return this.renderer.render(DynamicToolReporter.completed(event.item));
            case "mcpToolCall":
                return this.renderer.render(McpToolReporter.completed(event.item));
            case "commandExecution":
                return this.renderer.render(this.commands.completed(event.item, true));
            case "imageView":
                if (this.emittedImageViewItems.delete(event.item.id)) {
                    return null;
                }
                return this.renderer.render(ImageViewReporter.viewed(event.item));
            case "imageGeneration":
                return this.renderer.render(this.activeImageGenerationItems.delete(event.item.id)
                    ? ImageGenerationReporter.completed(event.item)
                    : ImageGenerationReporter.whole(event.item, {terminalStatus: true}));
            case "reasoning":
                if (this.seenReasoningDeltaItemIds.delete(event.item.id)) {
                    return null;
                }
                return this.createCompletedReasoningEvent(event.item);
            case "webSearch":
                return this.renderer.render(WebSearchReporter.completed(event.item));
            case "collabAgentToolCall":
                return this.renderer.render(this.subagents.legacyCollaborationCompleted(event.item));
            case "agentMessage":
                this.rememberAgentMessagePhase(event.item);
                return null;
            case "plan":
                return await this.createCompletedPlanEvent(event.item);
            case "exitedReviewMode":
                return this.createExitedReviewModeEvent(event.item);
            case "contextCompaction":
                return this.supportsCompaction
                    ? this.sessionState.compactions.complete(
                        this.subagents.notificationSessionId({method: "item/completed", params: event}),
                        event.turnId, event.item.id,
                    )
                    : this.renderer.render(CompactionReporter.completed(event.item));
            case "subAgentActivity":
                return this.renderer.render(this.subagents.legacyActivityCompleted(event.item));
            //ignored types
            case "sleep":
            case "functionCallOutput":
            case "userMessage":
            case "hookPrompt":
            case "enteredReviewMode":
                return null;
        }
    }

    private renderFacts(facts: ToolFacts | null): UpdateSessionEvent | null {
        return facts === null ? null : this.renderer.render(facts);
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

    private async createCompletedPlanEvent(item: ThreadItem & { type: "plan" }): Promise<UpdateSessionEvent | null> {
        const completed = await this.plans.completed(item.id, item.text);
        if (completed === null) return null;
        this.completedPlan = {itemId: item.id, text: completed.text};
        return completed.update;
    }

    private createExitedReviewModeEvent(item: ThreadItem & { type: "exitedReviewMode" }): UpdateSessionEvent | null {
        const text = item.review.trim();
        if (text.length === 0) {
            return null;
        }
        return createAgentTextMessageChunk(text);
    }

    private createContextCompactedEvent(): UpdateSessionEvent {
        if (!this.supportsNotices) {
            return createAgentTextMessageChunk("*Context compacted to fit the model's context window.*\n\n");
        }
        return createSessionNotice(
            "info",
            "Context compacted",
            "Conversation compacted to fit the model's context window.",
        );
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
        // The prompt error carries the message of such a failure, so the transcript does not repeat it.
        if (this.failure !== null && params.error.additionalDetails === null) {
            return null;
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
        const limitId = params.rateLimits.limitId ?? "codex";
        const existingEntry = this.sessionState.rateLimits.get(limitId);
        const snapshot = existingEntry
            ? mergeRateLimitSnapshot(existingEntry.snapshot, params.rateLimits)
            : {...params.rateLimits, limitId};
        this.sessionState.rateLimits.set(limitId, {
            limitId: limitId,
            limitName: snapshot.limitName ?? existingEntry?.limitName ?? limitId,
            snapshot,
        });
    }

}

function toolCallTitle(update: UpdateSessionEvent | null | undefined): string | undefined {
    if (update?.sessionUpdate !== "tool_call") return undefined;
    return update.title;
}
