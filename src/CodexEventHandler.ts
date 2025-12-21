import type {ServerNotification} from "./app-server";
import type {SessionState} from "./CodexAcpServer";
import * as acp from "@agentclientprotocol/sdk";
import {type PlanEntry, type ToolCallContent} from "@agentclientprotocol/sdk";
import {applyPatch} from "diff";
import {ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AgentMessageDeltaNotification,
    CommandAction,
    ErrorNotification,
    FileUpdateChange,
    ItemCompletedNotification,
    ItemStartedNotification,
    ThreadItem,
    TurnPlanUpdatedNotification
} from "./app-server/v2";
import {readFile} from "node:fs/promises";

export class CodexEventHandler {

    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;

    constructor(connection: acp.AgentSideConnection, sessionState: SessionState) {
        this.connection = connection;
        this.sessionState = sessionState;
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
            case "item/reasoning/summaryTextDelta": //TODO streaming reasoning?
            case "item/reasoning/summaryPartAdded":
            //skipped events
            case "item/reasoning/textDelta": //for raw output
            case "turn/diff/updated":
            case "item/commandExecution/outputDelta":
            case "item/fileChange/outputDelta":
            case "thread/tokenUsage/updated":
            case "item/mcpToolCall/progress":
            case "account/updated":
            case "account/rateLimits/updated":
            case "thread/compacted":
            case "windows/worldWritableWarning":
            case "account/login/completed":
            case "authStatusChange":
            case "loginChatGptComplete":
            case "sessionConfigured":
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
            status: "completed",
            content: patches,
        };
    }

    private async createPatchContent(change: FileUpdateChange): Promise<ToolCallContent | null> {
        const oldContent = change.kind.type === "add"
            ? null
            : await readFile(change.path, { encoding: "utf8" });
        const newContent = applyPatch(oldContent ?? "", change.diff);
        if (!newContent) {
            return null
        }
        return {
            type: "diff",
            oldText: oldContent,
            newText: newContent,
            path: change.path,
        }
    }

    private async createCommandEvent(item: ThreadItem & { "type": "commandExecution" }): Promise<UpdateSessionEvent> {
        const commandAction = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
        if (commandAction) {
            return this.createCommandActionEvent(item.id, commandAction);
        }
        const command = item.command.replace(/^(?:\/bin\/)?bash\s+/, "");
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            kind: "execute",
            title: command,
            status: "in_progress"
        }
    }

    private createCommandActionEvent(id: string, commandAction: CommandAction): UpdateSessionEvent {
        if (commandAction.type === "read") {
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: "in_progress",
                kind: "read",
                title: "Read file",
                locations: [{path: commandAction.path}],
            };
        } else if (commandAction.type === "search" && commandAction.query) {
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: "in_progress",
                kind: "search",
                title: `Search '${commandAction.query}'`,
            }
        }
        return {
            sessionUpdate: "tool_call",
            toolCallId: id,
            status: "in_progress",
            kind: "execute",
            title: commandAction.command,
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
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `❌ ${params.error.message}\n\n`
            }
        }
    }
}
