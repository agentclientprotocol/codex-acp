import type {SessionState} from "../CodexAcpServer";
import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {McpToolCallItem} from "../tool-calls/reporters/McpToolReporter";
import {commandToolName} from "../ToolCallName";

type FileChangeItem = ThreadItem & {type: "fileChange"};

/** Session-scoped permission state shared across prompt generations. */
export class PermissionLifecycleContext {
    private permissionRequestSequence = 0;

    constructor(private readonly session: Pick<SessionState, "sessionId">) {}

    beginPrompt(): PermissionPromptContext {
        return new PermissionPromptContext(serverName => this.nextStandaloneMcpToolCallId(serverName));
    }

    private nextStandaloneMcpToolCallId(serverName: string): string {
        this.permissionRequestSequence += 1;
        return ["elicitation", this.session.sessionId, serverName, this.permissionRequestSequence].join(":");
    }
}

/** Prompt-scoped permission presentation and MCP correlation state. */
export class PermissionPromptContext {
    private readonly commandNames = new Map<string, Map<string, string>>();
    private readonly fileChanges = new Map<string, Map<string, FileChangeItem>>();
    private readonly pendingMcpApprovals = new Map<string, Map<string, McpToolCallItem[]>>();

    constructor(private readonly nextStandaloneId: (serverName: string) => string) {}

    handleNotification(notification: ServerNotification): void {
        switch (notification.method) {
            case "item/started":
                this.handleItemStarted(notification.params.threadId, notification.params.item);
                return;
            case "item/completed":
                this.handleItemCompleted(notification.params.threadId, notification.params.item);
                return;
            case "turn/completed":
                this.clearTransientState(notification.params.threadId);
                return;
            case "serverRequest/resolved":
                this.pendingMcpApprovals.delete(notification.params.threadId);
                return;
            default:
                return;
        }
    }

    fileChange(threadId: string, itemId: string): FileChangeItem | undefined {
        return this.fileChanges.get(threadId)?.get(itemId);
    }

    commandName(threadId: string, itemId: string): string | undefined {
        return this.commandNames.get(threadId)?.get(itemId);
    }

    /** Tells whether the client already received the command tool call. */
    commandStarted(threadId: string, itemId: string): boolean {
        return this.commandNames.get(threadId)?.has(itemId) ?? false;
    }

    popPendingMcpApproval(threadId: string, serverName: string): McpToolCallItem | undefined {
        const byServer = this.pendingMcpApprovals.get(threadId);
        if (!byServer) return undefined;
        const pending = byServer.get(serverName);
        if (pending?.length !== 1) return undefined;
        const call = pending[0];
        byServer.delete(serverName);
        if (byServer.size === 0) this.pendingMcpApprovals.delete(threadId);
        return call;
    }

    nextStandaloneMcpToolCallId(serverName: string): string {
        return this.nextStandaloneId(serverName);
    }

    private handleItemStarted(threadId: string, item: ThreadItem): void {
        if (item.type === "commandExecution") {
            const byItem = this.commandNames.get(threadId) ?? new Map<string, string>();
            byItem.set(item.id, commandToolName(item.source));
            this.commandNames.set(threadId, byItem);
            return;
        }
        if (item.type === "fileChange") {
            const byItem = this.fileChanges.get(threadId) ?? new Map<string, FileChangeItem>();
            byItem.set(item.id, item);
            this.fileChanges.set(threadId, byItem);
            return;
        }
        if (item.type !== "mcpToolCall") return;
        const byServer = this.pendingMcpApprovals.get(threadId) ?? new Map<string, McpToolCallItem[]>();
        const pending = byServer.get(item.server);
        if (pending) pending.push(item);
        else byServer.set(item.server, [item]);
        this.pendingMcpApprovals.set(threadId, byServer);
    }

    private handleItemCompleted(threadId: string, item: ThreadItem): void {
        if (item.type === "commandExecution") {
            const byItem = this.commandNames.get(threadId);
            byItem?.delete(item.id);
            if (byItem?.size === 0) this.commandNames.delete(threadId);
            return;
        }
        if (item.type === "fileChange") {
            const byItem = this.fileChanges.get(threadId);
            byItem?.delete(item.id);
            if (byItem?.size === 0) this.fileChanges.delete(threadId);
            return;
        }
        if (item.type !== "mcpToolCall") return;
        const byServer = this.pendingMcpApprovals.get(threadId);
        if (!byServer) return;
        const pending = byServer.get(item.server);
        if (!pending) return;
        const index = pending.findIndex(call => call.id === item.id);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) byServer.delete(item.server);
        if (byServer.size === 0) this.pendingMcpApprovals.delete(threadId);
    }

    private clearTransientState(threadId: string): void {
        this.commandNames.delete(threadId);
        this.fileChanges.delete(threadId);
        this.pendingMcpApprovals.delete(threadId);
    }
}
