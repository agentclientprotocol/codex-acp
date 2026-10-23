import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ServerNotification} from "../app-server";
import {CodexElicitationHandler} from "../CodexElicitationHandler";
import {CodexApprovalHandler} from "../permissions/CodexApprovalHandler";
import {PermissionLifecycleContext, type PermissionPromptContext} from "../permissions/lifecycle";
import {AcpToolCallRenderer} from "../tool-calls/AcpToolCallRenderer";

/** Child interaction state survives parent prompt and attachment changes, like the child conversation. */
export class SubagentInteractionHandlers {
    private readonly context: PermissionPromptContext;
    readonly approvals: CodexApprovalHandler;
    readonly elicitations: CodexElicitationHandler;

    constructor(
        connection: AcpClientConnection,
        rootSessionId: string,
        capabilities: acp.ClientCapabilities | null,
        renderer: AcpToolCallRenderer,
    ) {
        this.context = new PermissionLifecycleContext({sessionId: rootSessionId}).beginPrompt();
        // StandardSubagentEventRouter supplies each request's cancellation scope through SubagentInteraction.
        this.approvals = new CodexApprovalHandler(connection, this.context, undefined, renderer);
        this.elicitations = new CodexElicitationHandler(connection, this.context, capabilities, undefined, renderer);
    }

    async observe(event: ServerNotification, sessionId: string): Promise<void> {
        const scoped = {...event, params: {...event.params, threadId: sessionId}} as ServerNotification;
        this.context.handleNotification(scoped);
        await this.elicitations.handleNotification(scoped);
    }
}
