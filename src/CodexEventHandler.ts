import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
    ServerNotification
} from "./app-server";
import type {SessionState} from "./CodexAcpServer";
import * as acp from "@agentclientprotocol/sdk";
import {type PlanEntry, RequestError} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AccountRateLimitsUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    CommandExecutionOutputDeltaNotification,
    ConfigWarningNotification,
    ErrorNotification,
    GuardianWarningNotification,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    ThreadItem,
    ModelReroutedNotification,
    ThreadGoalClearedNotification,
    ThreadGoalUpdatedNotification,
    ThreadTokenUsageUpdatedNotification,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import type { McpStartupCompleteEvent } from "./app-server";
import {toTokenCount} from "./TokenCount";
import {
    createCommandExecutionUpdate,
    createDynamicToolCallUpdate,
    createFileChangeUpdate,
    createGuardianApprovalReviewToolCall,
    createGuardianApprovalReviewToolCallUpdate,
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

export { stripShellPrefix };

export class CodexEventHandler {

    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
    private failure: RequestError | null = null;
    private readonly activeFuzzyFileSearchSessions = new Set<string>();
    private readonly activeGuardianApprovalReviews = new Set<string>();

    constructor(connection: acp.AgentSideConnection, sessionState: SessionState) {
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
                return this.createGuardianWarningEvent(notification.params);
            case "item/autoApprovalReview/started":
                return this.handleGuardianApprovalReviewStarted(notification.params);
            case "item/autoApprovalReview/completed":
                return this.handleGuardianApprovalReviewCompleted(notification.params);
            case "thread/compacted":
                return this.createContextCompactedEvent();
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
            // ignored events
            case "command/exec/outputDelta":
            case "hook/started":
            case "hook/completed":
            case "item/reasoning/summaryTextDelta":
            case "item/reasoning/summaryPartAdded":
            case "item/reasoning/textDelta":
            case "turn/diff/updated":
            case "item/commandExecution/terminalInteraction":
            case "item/fileChange/outputDelta":
            case "item/fileChange/patchUpdated":
            case "account/updated":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
            case "serverRequest/resolved":
            case "model/verification":
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
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: event.delta
            }
        }
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        const detailsText = event.details ? `\n\n${event.details}` : "";
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `Config warning: ${event.summary}${detailsText}\n\n`
            }
        }
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `Warning: ${event.message}\n\n`
            }
        };
    }

    private createGuardianWarningEvent(event: GuardianWarningNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `Guardian warning: ${event.message}\n\n`
            }
        };
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_thought_chunk",
            content: {
                type: "text",
                text: `Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`
            }
        };
    }

    private createThreadGoalUpdatedEvent(event: ThreadGoalUpdatedNotification): UpdateSessionEvent {
        const status = this.formatThreadGoalStatus(event.goal.status);
        const objective = event.goal.objective.trim();
        const text = objective.includes("\n")
            ? `Goal updated (${status}):\n${objective}`
            : `Goal updated (${status}): ${objective}`;
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text,
            },
        };
    }

    private formatThreadGoalStatus(status: ThreadGoalUpdatedNotification["goal"]["status"]): string {
        switch (status) {
            case "active":
                return "active";
            case "paused":
                return "paused";
            case "budgetLimited":
                return "budget limited";
            case "blocked":
                return "blocked";
            case "usageLimited":
                return "usage limited";
            case "complete":
                return "complete";
        }
    }

    private createThreadGoalClearedEvent(_event: ThreadGoalClearedNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: "Goal cleared.",
            },
        };
    }

    private async createItemEvent(event: ItemStartedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
                return await createFileChangeUpdate(event.item);
            case "commandExecution":
                return await createCommandExecutionUpdate(event.item);
            case "mcpToolCall":
                return await createMcpToolCallUpdate(event.item);
            case "dynamicToolCall":
                return await createDynamicToolCallUpdate(event.item);
            case "webSearch":
                return createWebSearchStartUpdate(event.item);
            case "collabAgentToolCall":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "reasoning":
            case "imageView":
            case "imageGeneration":
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
            case "reasoning":
                const summary = event.item.summary[0];
                if (!summary) return null;
                return {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                        type: "text",
                        text: summary
                    }
                }
            case "webSearch":
                return createWebSearchCompleteUpdate(event.item);
            case "collabAgentToolCall":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "imageView":
            case "imageGeneration":
            case "enteredReviewMode":
            case "plan":
                return null;
            case "exitedReviewMode":
                return this.createExitedReviewModeEvent(event.item);
            case "contextCompaction":
                return this.createContextCompactedEvent();
        }
    }

    private createExitedReviewModeEvent(item: ThreadItem & { type: "exitedReviewMode" }): UpdateSessionEvent | null {
        const text = item.review.trim();
        if (text.length === 0) {
            return null;
        }
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text,
            }
        };
    }

    private createContextCompactedEvent(): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: "*Context compacted to fit the model's context window.*\n\n"
            }
        };
    }

    private createCommandOutputDeltaEvent(event: CommandExecutionOutputDeltaNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: event.itemId,
            _meta: {
                terminal_output_delta: {
                    data: event.delta,
                    terminal_id: event.itemId
                }
            }
        }
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
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: item.id,
            status: item.status === "completed" ? "completed" : "failed",
            rawOutput: {
                formatted_output: item.aggregatedOutput ?? "",
                exit_code: item.exitCode
            },
            _meta: {
                terminal_exit: {
                    exit_code: item.exitCode,
                    signal: null,
                    terminal_id: item.id
                }
            }
        }
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
        const error = params.error.codexErrorInfo
        if (error == "unauthorized" || error == "usageLimitExceeded" || this.getHttpStatusCode(error) == 401) {
            this.failure = RequestError.authRequired();
        }
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `${params.error.message}\n\n`
            }
        }
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
