import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
    ServerNotification
} from "./app-server";
import type {SessionState, ThreadGoalSnapshot} from "./CodexAcpServer";
import {type PlanEntry, RequestError} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type AcpClientConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AccountRateLimitsUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    CommandExecutionOutputDeltaNotification,
    ConfigWarningNotification,
    ErrorNotification,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    ThreadItem,
    ModelReroutedNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    TerminalInteractionNotification,
    ThreadGoalClearedNotification,
    ThreadGoalUpdatedNotification,
    ThreadTokenUsageUpdatedNotification,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import type { McpStartupCompleteEvent } from "./app-server";
import {toTokenCount} from "./TokenCount";
import {
    commandExecutionUsesTerminalOutput,
    createCollabAgentToolCallCompleteUpdate,
    createCollabAgentToolCallUpdate,
    createCommandExecutionUpdate,
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
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
} from "./ContentChunks";

export { stripShellPrefix };

export class CodexEventHandler {

    private readonly connection: AcpClientConnection;
    private readonly sessionState: SessionState;
    private failure: RequestError | null = null;
    private readonly activeFuzzyFileSearchSessions = new Set<string>();
    private readonly activeGuardianApprovalReviews = new Set<string>();
    private readonly activeImageGenerationItems = new Set<string>();
    private readonly emittedImageViewItems = new Set<string>();
    private readonly seenReasoningDeltaItemIds = new Set<string>();
    private readonly terminalCommandIds = new Set<string>();
    private readonly terminalCommandOutputIds = new Set<string>();

    constructor(connection: AcpClientConnection, sessionState: SessionState) {
        this.connection = connection;
        this.sessionState = sessionState;
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    async handleNotification(notification: ServerNotification) {
        const session = new ACPSessionConnection(this.connection, this.sessionState.sessionId);
        const updateEvent = await this.createUpdateEvent(notification);
        if (updateEvent) {
            await session.update(updateEvent);
        }
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
                return await this.createTextEvent(notification.params);
            case "item/started":
                return await this.createItemEvent(notification.params);
            case "item/completed":
                return await this.completeItemEvent(notification.params);
            case "turn/plan/updated":
                return await this.updatePlan(notification.params);
            case "error":
                return await this.createErrorEvent(notification.params);
            case "turn/started":
                this.sessionState.currentTurnId = notification.params.turn.id;
                return null;
            case "turn/completed":
                this.sessionState.currentTurnId = null;
                return null;
            case "thread/tokenUsage/updated":
                return this.createUsageUpdate(notification.params);
            case "thread/name/updated":
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
                return this.createCommandOutputDeltaEvent(notification.params);
            case "item/mcpToolCall/progress":
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
            case "item/autoApprovalReview/started":
                return this.handleGuardianApprovalReviewStarted(notification.params);
            case "item/autoApprovalReview/completed":
                return this.handleGuardianApprovalReviewCompleted(notification.params);
            case "thread/compacted":
                return this.createContextCompactedEvent();
            case "item/reasoning/summaryTextDelta":
                return this.createReasoningDeltaEvent(notification.params);
            case "item/reasoning/textDelta":
                return this.createReasoningDeltaEvent(notification.params);
            case "item/reasoning/summaryPartAdded":
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
            case "deprecationNotice":
            case "mcpServer/oauthLogin/completed":
            case "externalAgentConfig/import/completed":
            case "rawResponseItem/completed":
            case "thread/started":
            case "item/plan/delta":
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
        return createAgentTextMessageChunk(event.delta, event.itemId);
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        const detailsText = event.details ? `\n\n${event.details}` : "";
        return createAgentTextMessageChunk(`Config warning: ${event.summary}${detailsText}\n\n`);
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        return createAgentTextMessageChunk(`Warning: ${event.message}\n\n`);
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        return createAgentTextThoughtChunk(`Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`);
    }

    private createThreadGoalUpdatedEvent(event: ThreadGoalUpdatedNotification): UpdateSessionEvent | null {
        const goalSnapshot = this.createThreadGoalSnapshot(event);
        if (this.sameThreadGoalSnapshot(this.sessionState.currentGoal, goalSnapshot)) {
            return null;
        }
        this.sessionState.currentGoal = goalSnapshot;

        return this.createCodexSessionInfoUpdate({
            goal: goalSnapshot,
        });
    }

    private createThreadGoalClearedEvent(_event: ThreadGoalClearedNotification): UpdateSessionEvent | null {
        if (this.sessionState.currentGoal === null) {
            return null;
        }
        this.sessionState.currentGoal = null;

        return this.createCodexSessionInfoUpdate({
            goal: null,
        });
    }

    private createThreadGoalSnapshot(event: ThreadGoalUpdatedNotification): ThreadGoalSnapshot {
        return {
            objective: event.goal.objective.trim(),
            status: event.goal.status,
            tokenBudget: event.goal.tokenBudget,
        };
    }

    private sameThreadGoalSnapshot(
        left: ThreadGoalSnapshot | null | undefined,
        right: ThreadGoalSnapshot
    ): boolean {
        return left !== null
            && left !== undefined
            && left.objective === right.objective
            && left.status === right.status
            && left.tokenBudget === right.tokenBudget;
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
                return createCollabAgentToolCallUpdate(event.item);
            case "subAgentActivity":
            case "sleep":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "reasoning":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "contextCompaction":
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
                return createCollabAgentToolCallCompleteUpdate(event.item);
            case "exitedReviewMode":
                return this.createExitedReviewModeEvent(event.item);
            case "contextCompaction":
                return this.createContextCompactedEvent();
            //ignored types
            case "subAgentActivity":
            case "sleep":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "enteredReviewMode":
            case "plan":
                return null;

        }
    }

    private createCompletedReasoningEvent(item: ThreadItem & { type: "reasoning" }): UpdateSessionEvent | null {
        const parts = item.summary.length > 0 ? item.summary : item.content;
        const text = parts.filter(part => part.length > 0).join("\n\n");
        if (text.length === 0) {
            return null;
        }
        return this.createAgentThoughtEvent(text, item.id);
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

    private async createErrorEvent(params: ErrorNotification): Promise<UpdateSessionEvent> {
        const error = params.error.codexErrorInfo;
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

    private isAuthenticationRequiredError(error: CodexErrorInfo | null): boolean {
        return error === "unauthorized" || this.getHttpStatusCode(error) === 401;
    }

    private getHttpStatusCode(error: CodexErrorInfo | null): number | null {
        if (error !== null && typeof error === "object") {
            if ("httpConnectionFailed" in error) {
                return error.httpConnectionFailed.httpStatusCode;
            } else if ("responseStreamConnectionFailed" in error) {
                return error.responseStreamConnectionFailed.httpStatusCode;
            } else if ("responseStreamDisconnected" in error) {
                return error.responseStreamDisconnected.httpStatusCode;
            } else if ("responseTooManyFailedAttempts" in error) {
                return error.responseTooManyFailedAttempts.httpStatusCode;
            }
        }
        return null;
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
