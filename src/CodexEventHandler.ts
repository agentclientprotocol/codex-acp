import type {ServerNotification} from "./app-server";
import type {SessionState} from "./CodexAcpServer";
import * as acp from "@agentclientprotocol/sdk";
import {type PlanEntry, RequestError, type ToolCallContent} from "@agentclientprotocol/sdk";
import {applyPatch} from "diff";
import {ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AccountRateLimitsUpdatedNotification,
    AgentMessageDeltaNotification, CodexErrorInfo,
    CommandAction,
    CommandExecutionStatus,
    ErrorNotification,
    FileUpdateChange,
    ItemCompletedNotification,
    ItemStartedNotification,
    PatchApplyStatus,
    ThreadItem,
    ThreadTokenUsageUpdatedNotification,
    TurnPlanUpdatedNotification
} from "./app-server/v2";
import {readFile} from "node:fs/promises";
import {toTokenCount} from "./TokenCount";
type CodexItemStatus = CommandExecutionStatus | PatchApplyStatus;
type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

function toAcpStatus(status: CodexItemStatus): AcpToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "completed":
            return "completed";
        case "failed":
        case "declined":
            return "failed";
    }
}

export class CodexEventHandler {

    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
    private failure: RequestError | null = null;

    constructor(connection: acp.AgentSideConnection, sessionState: SessionState) {
        this.connection = connection;
        this.sessionState = sessionState;
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    async handleNotification(notification: ServerNotification) {
        const session = new ACPSessionConnection(this.connection, this.sessionState.sessionMetadata.sessionId);
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
            case "item/reasoning/summaryTextDelta": //TODO streaming reasoning?
            case "item/reasoning/summaryPartAdded":
            //skipped events
            case "item/reasoning/textDelta": //for raw output
            case "turn/diff/updated":
            case "item/commandExecution/outputDelta":
            case "item/commandExecution/terminalInteraction":
            case "item/fileChange/outputDelta":
            case "item/mcpToolCall/progress":
            case "account/updated":
                return null;
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "thread/compacted":
            case "windows/worldWritableWarning":
            case "account/login/completed":
            case "authStatusChange":
            case "loginChatGptComplete":
            case "sessionConfigured":
            case "deprecationNotice":
            case "mcpServer/oauthLogin/completed":
            case "rawResponseItem/completed":
            case "thread/started":
                return null;
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

    private async createItemEvent(event: ItemStartedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
                return await this.createFileChangeEvent(event.item)
            case "commandExecution":
                return await this.createCommandEvent(event.item)
            case "userMessage":
            case "agentMessage":
            case "reasoning":
            case "mcpToolCall":
            case "webSearch":
            case "imageView":
            case "enteredReviewMode":
            case "exitedReviewMode":
                return null;
        }
    }

    private async completeItemEvent(event: ItemCompletedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
            case "commandExecution":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed"
                }
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
            case "userMessage":
            case "agentMessage":
            case "mcpToolCall":
            case "webSearch":
            case "imageView":
            case "enteredReviewMode":
            case "exitedReviewMode":
                return null;
        }
    }

    private async createFileChangeEvent(item: ThreadItem & { "type": "fileChange" }): Promise<UpdateSessionEvent | null> {
        const patches: ToolCallContent[] = [];
        for (const change of item.changes) {
            const content = await this.createPatchContent(change);
            if (content) patches.push(content);
            //TODO handle errors (nulls)
        }
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            title: "Editing files",
            kind: "edit",
            status: toAcpStatus(item.status),
            content: patches,
        };
    }

    private async createPatchContent(change: FileUpdateChange): Promise<ToolCallContent | null> {
        if (change.kind.type === "add" && !this.isUnifiedDiff(change.diff)) {
            // For new files, diff may contain raw file content instead of a patch
            return {
                type: "diff",
                oldText: null,
                newText: change.diff,
                path: change.path,
            }
        }

        const oldContent = change.kind.type === "add" ? "" : await readFile(change.path, { encoding: "utf8" });
        const newContent = applyPatch(oldContent, change.diff);
        if (newContent === false) {
            return null
        }
        return {
            type: "diff",
            oldText: change.kind.type === "add" ? null : oldContent,
            newText: newContent,
            path: change.path,
        }
    }

    private isUnifiedDiff(content: string): boolean {
        return content.startsWith('--- ') || content.includes('\n--- ');
    }

    private async createCommandEvent(item: ThreadItem & { "type": "commandExecution" }): Promise<UpdateSessionEvent> {
        const commandAction = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
        if (commandAction) {
            return this.createCommandActionEvent(item.id, item.status, commandAction);
        }
        const command = item.command.replace(/^(?:\/bin\/)?bash\s+/, "");
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            kind: "execute",
            title: command,
            status: toAcpStatus(item.status)
        }
    }

    private createCommandActionEvent(id: string, status: CommandExecutionStatus, commandAction: CommandAction): UpdateSessionEvent {
        const acpStatus = toAcpStatus(status);
        if (commandAction.type === "read") {
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: acpStatus,
                kind: "read",
                title: "Read file",
                locations: [{path: commandAction.path}],
            };
        } else if (commandAction.type === "search") {
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: acpStatus,
                kind: "search",
                title: this.createSearchTitle(commandAction.query, commandAction.path),
            }
        } else if (commandAction.type === "listFiles") {
            const title = commandAction.path
                ? `List files in '${commandAction.path}'`
                : "List files";
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: acpStatus,
                kind: "read",
                title: title,
            }
        }
        return {
            sessionUpdate: "tool_call",
            toolCallId: id,
            status: acpStatus,
            kind: "execute",
            title: commandAction.command,
        }
    }

    private createSearchTitle(query: string | null, path: string | null): string {
        if (query && path) {
            return `Search for '${query}' in ${path}`;
        } else if (query) {
            return `Search for '${query}'`;
        } else if (path) {
            return `Search in '${path}'`;
        }
        return "Search";
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
        this.sessionState.rateLimits = params.rateLimits;
    }
}
