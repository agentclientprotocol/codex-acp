import * as acp from "@agentclientprotocol/sdk";
import type {ApprovalHandler} from "../CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    GrantedPermissionProfile,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    RequestPermissionProfile,
} from "../app-server/v2";
import {logger} from "../Logger";
import type {AcpClientConnection} from "../ACPSessionConnection";
import {
    commandDecisionOptions,
    fileChangeDecisionOptions,
    permissionProfileOptions,
    type CommandParamsWithAvailableDecisions,
    type DecisionOption,
} from "./options";
import {ApprovalOptionId} from "./option-ids";
import {
    CODEX_ADDITIONAL_PERMISSIONS_TITLE,
    CODEX_COMMAND_PERMISSION_TITLE,
    CODEX_FILE_CHANGE_PERMISSION_TITLE,
    CODEX_NETWORK_PERMISSION_TITLE,
    requestPermissionMeta,
} from "./metadata";
import {additionalPermissionsToolCall, commandToolCall, fileChangeToolCall} from "./presentation";
import type {PermissionPromptContext} from "./lifecycle";

export class CodexApprovalHandler implements ApprovalHandler {
    constructor(
        private readonly connection: AcpClientConnection,
        private readonly permissionContext: PermissionPromptContext,
        private readonly cancellationSignal?: AbortSignal,
    ) {}

    async handleCommandExecution(
        params: CommandExecutionRequestApprovalParams,
    ): Promise<CommandExecutionRequestApprovalResponse> {
        const authoritativeParams = params as CommandParamsWithAvailableDecisions;
        const decisions = commandDecisionOptions(authoritativeParams);
        if (!decisions) {
            logger.error("Cancelling command approval without a complete authoritative decision set", undefined);
            return {decision: "cancel"};
        }

        try {
            const response = await this.requestPermission({
                sessionId: params.threadId,
                toolCall: commandToolCall(authoritativeParams),
                options: decisions.map(({option}) => option),
                _meta: requestPermissionMeta(
                    params.networkApprovalContext ? CODEX_NETWORK_PERMISSION_TITLE : CODEX_COMMAND_PERMISSION_TITLE,
                    params.reason,
                ),
            });
            return {decision: this.selectedDecision(response, decisions) ?? "cancel"};
        } catch (error) {
            logger.error("Error requesting command execution permission", error);
            return {decision: "cancel"};
        }
    }

    async handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse> {
        const decisions = fileChangeDecisionOptions();
        try {
            const response = await this.requestPermission({
                sessionId: params.threadId,
                toolCall: fileChangeToolCall(params, this.permissionContext),
                options: decisions.map(({option}) => option),
                _meta: requestPermissionMeta(CODEX_FILE_CHANGE_PERMISSION_TITLE, params.reason),
            });
            return {decision: this.selectedDecision(response, decisions) ?? "cancel"};
        } catch (error) {
            logger.error("Error requesting file change permission", error);
            return {decision: "cancel"};
        }
    }

    async handlePermissionsRequest(
        params: PermissionsRequestApprovalParams,
    ): Promise<PermissionsRequestApprovalResponse> {
        try {
            const response = await this.requestPermission({
                sessionId: params.threadId,
                toolCall: additionalPermissionsToolCall(
                    params.itemId,
                    params.cwd,
                    params.environmentId,
                    params.permissions,
                ),
                options: permissionProfileOptions(),
                _meta: requestPermissionMeta(CODEX_ADDITIONAL_PERMISSIONS_TITLE, params.reason),
            });
            return this.permissionsResponse(params.permissions, response);
        } catch (error) {
            logger.error("Error requesting permissions", error);
            return this.rejectPermissionsResponse();
        }
    }

    private requestPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
        return this.connection.request(
            acp.methods.client.session.requestPermission,
            request,
            this.cancellationSignal ? {cancellationSignal: this.cancellationSignal} : undefined,
        );
    }

    private selectedDecision<T>(response: acp.RequestPermissionResponse, decisions: DecisionOption<T>[]): T | undefined {
        if (response.outcome.outcome === "cancelled") return undefined;
        const optionId = response.outcome.optionId;
        return decisions.find(({option}) => option.optionId === optionId)?.decision;
    }

    private permissionsResponse(
        permissions: RequestPermissionProfile,
        response: acp.RequestPermissionResponse,
    ): PermissionsRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") return this.rejectPermissionsResponse();
        switch (response.outcome.optionId) {
            case ApprovalOptionId.AllowPermissionsForTurn:
                return this.grantedPermissionsResponse(permissions, "turn", false);
            case ApprovalOptionId.AllowPermissionsForTurnWithStrictAutoReview:
                return this.grantedPermissionsResponse(permissions, "turn", true);
            case ApprovalOptionId.AllowPermissionsForSession:
                return this.grantedPermissionsResponse(permissions, "session", false);
            case ApprovalOptionId.RejectPermissions:
            default:
                return this.rejectPermissionsResponse();
        }
    }

    private grantedPermissionsResponse(
        permissions: RequestPermissionProfile,
        scope: "turn" | "session",
        strictAutoReview: boolean,
    ): PermissionsRequestApprovalResponse {
        return {permissions: this.grantedPermissions(permissions), scope, strictAutoReview};
    }

    private rejectPermissionsResponse(): PermissionsRequestApprovalResponse {
        return {permissions: {}, scope: "turn", strictAutoReview: false};
    }

    private grantedPermissions(permissions: RequestPermissionProfile): GrantedPermissionProfile {
        return {
            ...(permissions.network ? {network: permissions.network} : {}),
            ...(permissions.fileSystem ? {fileSystem: permissions.fileSystem} : {}),
        };
    }
}
