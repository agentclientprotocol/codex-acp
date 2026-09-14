import type {SessionState} from "../CodexAcpServer";
import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";

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
    private readonly fileChanges = new Map<string, Map<string, FileChangeItem>>();
    private readonly pendingMcpApprovals = new Map<string, Map<string, string[]>>();

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

    popPendingMcpApproval(threadId: string, serverName: string): string | undefined {
        const byServer = this.pendingMcpApprovals.get(threadId);
        if (!byServer) return undefined;
        const pending = byServer.get(serverName);
        if (pending?.length !== 1) return undefined;
        const callId = pending[0];
        byServer.delete(serverName);
        if (byServer.size === 0) this.pendingMcpApprovals.delete(threadId);
        return callId;
    }

    nextStandaloneMcpToolCallId(serverName: string): string {
        return this.nextStandaloneId(serverName);
    }

    private handleItemStarted(threadId: string, item: ThreadItem): void {
        if (item.type === "fileChange") {
            const byItem = this.fileChanges.get(threadId) ?? new Map<string, FileChangeItem>();
            byItem.set(item.id, item);
            this.fileChanges.set(threadId, byItem);
            return;
        }
        if (item.type !== "mcpToolCall") return;
        const byServer = this.pendingMcpApprovals.get(threadId) ?? new Map<string, string[]>();
        const pending = byServer.get(item.server);
        if (pending) pending.push(item.id);
        else byServer.set(item.server, [item.id]);
        this.pendingMcpApprovals.set(threadId, byServer);
    }

    private handleItemCompleted(threadId: string, item: ThreadItem): void {
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
        const index = pending.indexOf(item.id);
        if (index >= 0) pending.splice(index, 1);
        if (pending.length === 0) byServer.delete(item.server);
        if (byServer.size === 0) this.pendingMcpApprovals.delete(threadId);
    }

    private clearTransientState(threadId: string): void {
        this.fileChanges.delete(threadId);
        this.pendingMcpApprovals.delete(threadId);
    }
}
