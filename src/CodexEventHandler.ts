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
    ItemCompletedNotification,
    ItemStartedNotification, ThreadItem,
    ModelReroutedNotification,
    ThreadTokenUsageUpdatedNotification,
    TurnPlanUpdatedNotification
} from "./app-server/v2";
import type { McpStartupCompleteEvent } from "./app-server";
import {toTokenCount} from "./TokenCount";
import {
    createCommandExecutionUpdate,
    createDynamicToolCallUpdate,
    createFileChangeUpdate,
    createFuzzyFileSearchComplete,
    createFuzzyFileSearchStartOrUpdate,
    createMcpToolCallUpdate,
    fuzzyFileSearchToolCallId,
} from "./CodexToolCallMapper";
import { stripShellPrefix } from "./CommandUtils";

export { stripShellPrefix };

export class CodexEventHandler {

    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
    private failure: RequestError | null = null;
    private readonly activeFuzzyFileSearchSessions = new Set<string>();

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
                this.handleTokenUsageUpdated(notification.params);
                return null;
            case "item/commandExecution/outputDelta":
                return this.createCommandOutputDeltaEvent(notification.params);
            case "command/exec/outputDelta":
            case "item/autoApprovalReview/started":
            case "item/autoApprovalReview/completed":
            case "hook/started":
            case "hook/completed":
                return null;
            case "item/reasoning/summaryTextDelta": //TODO streaming reasoning?
            case "item/reasoning/summaryPartAdded":
            //skipped events
            case "item/reasoning/textDelta": //for raw output
            case "turn/diff/updated":
            case "item/commandExecution/terminalInteraction":
            case "item/fileChange/outputDelta":
            case "item/mcpToolCall/progress":
            case "serverRequest/resolved":
            case "account/updated":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
                return null;
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "configWarning":
                return await this.createConfigWarningEvent(notification.params);
            case "thread/compacted":
                return {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                        type: "text",
                        text: "*Context compacted to fit the model's context window.*\n\n"
                    }
                };
            case "windows/worldWritableWarning":
            case "thread/status/changed":
            case "thread/archived":
            case "thread/unarchived":
            case "thread/closed":
            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/transcriptUpdated":
            case "thread/realtime/outputAudio/delta":
            case "thread/realtime/error":
            case "thread/realtime/closed":
            case "windowsSandbox/setupCompleted":
            case "account/login/completed":
            case "skills/changed":
            case "deprecationNotice":
            case "mcpServer/oauthLogin/completed":
            case "rawResponseItem/completed":
            case "thread/started":
            case "thread/name/updated":
            case "item/plan/delta":
            case "app/list/updated":
                return null;
            case "model/rerouted":
                return this.createModelReroutedEvent(notification.params);
            case "fuzzyFileSearch/sessionUpdated":
                return this.handleFuzzyFileSearchSessionUpdated(notification.params);
            case "fuzzyFileSearch/sessionCompleted":
                return this.handleFuzzyFileSearchSessionCompleted(notification.params);
        }
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

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_thought_chunk",
            content: {
                type: "text",
                text: `Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`
            }
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
            case "collabAgentToolCall":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "reasoning":
            case "webSearch":
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
            case "mcpToolCall":
            case "fileChange":
            case "dynamicToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed"
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
            case "collabAgentToolCall":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "webSearch":
            case "imageView":
            case "imageGeneration":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "contextCompaction":
            case "plan":
                return null;
        }
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
}
