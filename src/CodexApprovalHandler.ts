import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse
} from "./app-server/v2";
import {logger} from "./Logger";
import {stripShellPrefix} from "./CodexEventHandler";
import {ApprovalOptionId} from "./ApprovalOptionId";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: ApprovalOptionId.AllowOnce, name: "Allow Once", kind: "allow_once" },
    { optionId: ApprovalOptionId.AllowAlways, name: "Allow for Session", kind: "allow_always" },
    { optionId: ApprovalOptionId.RejectOnce, name: "Reject", kind: "reject_once" },
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
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildCommandPermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertCommandResponse(response);
        } catch (error) {
            logger.error("Error requesting command execution permission", error);
            return { decision: "cancel" };
        }
    }

    async handleFileChange(
        params: FileChangeRequestApprovalParams
    ): Promise<FileChangeRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildFileChangePermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertFileChangeResponse(response);
        } catch (error) {
            logger.error("Error requesting file change permission", error);
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
                kind: "execute",
                status: "pending",
                ...(params.command ? { rawInput: { command: stripShellPrefix(params.command), cwd: params.cwd } } : {}),
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
        if (optionId === ApprovalOptionId.AllowOnce) {
            return { decision: "accept" };
        } else if (optionId === ApprovalOptionId.AllowAlways) {
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
        if (optionId === ApprovalOptionId.AllowOnce) {
            return { decision: "accept" };
        } else if (optionId === ApprovalOptionId.AllowAlways) {
            return { decision: "acceptForSession" };
        } else {
            return { decision: "cancel" };
        }
    }
}
