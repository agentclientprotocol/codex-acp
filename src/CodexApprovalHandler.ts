import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse
} from "./app-server/v2";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

export class CodexApprovalHandler implements ApprovalHandler {
    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;

    constructor(
        connection: acp.AgentSideConnection,
        sessionState: SessionState
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
    }

    async handleCommandExecution(
        params: CommandExecutionRequestApprovalParams
    ): Promise<CommandExecutionRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionMetadata.sessionId;
            const acpRequest = this.buildCommandPermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertCommandResponse(response);
        } catch (error) {
            console.error("Error requesting command execution permission:", error);
            return { decision: "cancel" };
        }
    }

    async handleFileChange(
        params: FileChangeRequestApprovalParams
    ): Promise<FileChangeRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionMetadata.sessionId;
            const acpRequest = this.buildFileChangePermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertFileChangeResponse(response);
        } catch (error) {
            console.error("Error requesting file change permission:", error);
            return { decision: "cancel" };
        }
    }

    private buildCommandPermissionRequest(
        sessionId: string,
        params: CommandExecutionRequestApprovalParams
    ): acp.RequestPermissionRequest {
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                title: params.reason ?? "Execute command",
                kind: "execute",
                status: "pending",
            },
            options: APPROVAL_OPTIONS,
        };
    }

    private buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): acp.RequestPermissionRequest {
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                title: params.reason ?? "Edit file",
                kind: "edit",
                status: "pending",
            },
            options: APPROVAL_OPTIONS,
        };
    }

    private convertCommandResponse(
        response: acp.RequestPermissionResponse
    ): CommandExecutionRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return { decision: "cancel" };
        }

        const optionId = response.outcome.optionId;
        if (optionId === "allow_once") {
            return { decision: "accept" };
        } else if (optionId === "allow_always") {
            return { decision: "acceptForSession" };
        } else {
            return { decision: "decline" };
        }
    }

    private convertFileChangeResponse(
        response: acp.RequestPermissionResponse
    ): FileChangeRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return { decision: "cancel" };
        }

        const optionId = response.outcome.optionId;
        if (optionId === "allow_once") {
            return { decision: "accept" };
        } else if (optionId === "allow_always") {
            return { decision: "acceptForSession" };
        } else {
            return { decision: "decline" };
        }
    }
}
