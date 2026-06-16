import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeApprovalDecision,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    GrantedPermissionProfile,
    NetworkPolicyAmendment,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    RequestPermissionProfile,
} from "./app-server/v2";
import {logger} from "./Logger";
import {stripShellPrefix} from "./CodexEventHandler";
import {ApprovalOptionId} from "./ApprovalOptionId";

type CommandDecisionOption = {
    option: acp.PermissionOption;
    decision: CommandExecutionApprovalDecision;
};

type FileChangeDecisionOption = {
    option: acp.PermissionOption;
    decision: FileChangeApprovalDecision;
};

function permissionOption(
    optionId: string,
    name: string,
    kind: acp.PermissionOptionKind,
    codexMeta?: Record<string, unknown>,
): acp.PermissionOption {
    return {
        optionId,
        name,
        kind,
        ...(codexMeta ? { _meta: { codex: codexMeta } } : {}),
    };
}

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
            return this.convertCommandResponse(params, response);
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
            return this.convertFileChangeResponse(params, response);
        } catch (error) {
            logger.error("Error requesting file change permission", error);
            return { decision: "cancel" };
        }
    }

    async handlePermissionsRequest(
        params: PermissionsRequestApprovalParams
    ): Promise<PermissionsRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildPermissionsRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertPermissionsResponse(params, response);
        } catch (error) {
            logger.error("Error requesting permissions", error);
            return this.rejectPermissionsResponse();
        }
    }

    private buildCommandPermissionRequest(
        sessionId: string,
        params: CommandExecutionRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const options = this.buildCommandOptions(params).map(({ option }) => option);
        const content = this.createContent([
            params.reason ?? null,
            this.formatNetworkApprovalContext(params),
            this.formatExecpolicyAmendment(params),
            this.formatNetworkPolicyAmendments(params),
        ]);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "execute",
                status: "pending",
                rawInput: params.command ? { command: stripShellPrefix(params.command), cwd: params.cwd } : null,
                ...(content ? { content } : {}),
            },
            options,
            _meta: { codex: { params } }
        };
    }

    private buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const options = this.buildFileChangeOptions(params).map(({ option }) => option);
        const content = this.createContent([
            params.reason ?? null,
            params.grantRoot ? `Grant Root: ${params.grantRoot}` : null,
        ]);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "edit",
                status: "pending",
                ...(content ? { content } : {}),
            },
            options,
            _meta: { codex: { params } }
        };
    }

    private buildPermissionsRequest(
        sessionId: string,
        params: PermissionsRequestApprovalParams,
    ): acp.RequestPermissionRequest {
        const content = this.createContent([
            params.reason,
            this.formatRequestedPermissions(params.permissions),
        ]);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "other",
                status: "pending",
                title: params.reason ?? "Permissions Request",
                rawInput: params,
                ...(content ? { content } : {}),
            },
            options: [
                permissionOption(
                    ApprovalOptionId.AllowPermissionsForSession,
                    "Allow for Session",
                    "allow_always",
                    { decision: "allowPermissionsForSession", permissions: params.permissions },
                ),
                permissionOption(
                    ApprovalOptionId.AllowPermissionsForTurn,
                    "Allow Once",
                    "allow_once",
                    { decision: "allowPermissionsForTurn", permissions: params.permissions },
                ),
                permissionOption(
                    ApprovalOptionId.RejectPermissions,
                    "Reject",
                    "reject_once",
                    { decision: "rejectPermissions" },
                ),
            ],
            _meta: { codex: { params } },
        };
    }

    private convertCommandResponse(
        params: CommandExecutionRequestApprovalParams,
        response: acp.RequestPermissionResponse
    ): CommandExecutionRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return { decision: "cancel" };
        }

        const optionId = response.outcome.optionId;
        const decision = this.buildCommandOptions(params)
            .find(({ option }) => option.optionId === optionId)
            ?.decision;
        return { decision: decision ?? "decline" };
    }

    private convertFileChangeResponse(
        params: FileChangeRequestApprovalParams,
        response: acp.RequestPermissionResponse
    ): FileChangeRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return { decision: "cancel" };
        }

        const optionId = response.outcome.optionId;
        const decision = this.buildFileChangeOptions(params)
            .find(({ option }) => option.optionId === optionId)
            ?.decision;
        return { decision: decision ?? "decline" };
    }

    private convertPermissionsResponse(
        params: PermissionsRequestApprovalParams,
        response: acp.RequestPermissionResponse,
    ): PermissionsRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return this.rejectPermissionsResponse();
        }

        switch (response.outcome.optionId) {
            case ApprovalOptionId.AllowPermissionsForSession:
            case ApprovalOptionId.AllowAlways:
                return {
                    permissions: this.grantedPermissions(params.permissions),
                    scope: "session",
                    strictAutoReview: false,
                };
            case ApprovalOptionId.AllowPermissionsForTurn:
            case ApprovalOptionId.AllowOnce:
                return {
                    permissions: this.grantedPermissions(params.permissions),
                    scope: "turn",
                    strictAutoReview: false,
                };
            default:
                return this.rejectPermissionsResponse();
        }
    }

    private buildCommandOptions(params: CommandExecutionRequestApprovalParams): CommandDecisionOption[] {
        const options: CommandDecisionOption[] = [
            {
                option: permissionOption(ApprovalOptionId.AllowOnce, "Allow Once", "allow_once", { decision: "accept" }),
                decision: "accept",
            },
            {
                option: permissionOption(
                    ApprovalOptionId.AllowAlways,
                    params.networkApprovalContext
                        ? "Allow Host for Session"
                        : "Allow for Session",
                    "allow_always",
                    { decision: "acceptForSession" },
                ),
                decision: "acceptForSession",
            },
        ];

        if (params.proposedExecpolicyAmendment && params.proposedExecpolicyAmendment.length > 0) {
            options.push({
                option: permissionOption(
                    ApprovalOptionId.AcceptWithExecpolicyAmendment,
                    this.execpolicyAmendmentLabel(params.proposedExecpolicyAmendment),
                    "allow_always",
                    {
                        decision: "acceptWithExecpolicyAmendment",
                        execpolicyAmendment: params.proposedExecpolicyAmendment,
                    },
                ),
                decision: {
                    acceptWithExecpolicyAmendment: {
                        execpolicy_amendment: params.proposedExecpolicyAmendment,
                    },
                },
            });
        }

        params.proposedNetworkPolicyAmendments?.forEach((amendment, index) => {
            options.push({
                option: permissionOption(
                    this.networkPolicyAmendmentOptionId(index),
                    this.networkPolicyAmendmentLabel(amendment),
                    amendment.action === "allow" ? "allow_always" : "reject_always",
                    {
                        decision: "applyNetworkPolicyAmendment",
                        networkPolicyAmendment: amendment,
                    },
                ),
                decision: {
                    applyNetworkPolicyAmendment: {
                        network_policy_amendment: amendment,
                    },
                },
            });
        });

        options.push({
            option: permissionOption(ApprovalOptionId.RejectOnce, "Reject", "reject_once", { decision: "decline" }),
            decision: "decline",
        });

        return options;
    }

    private buildFileChangeOptions(params: FileChangeRequestApprovalParams): FileChangeDecisionOption[] {
        return [
            {
                option: permissionOption(ApprovalOptionId.AllowOnce, "Allow Once", "allow_once", { decision: "accept" }),
                decision: "accept",
            },
            {
                option: permissionOption(
                    ApprovalOptionId.AllowAlways,
                    params.grantRoot ? "Allow Root for Session" : "Allow for Session",
                    "allow_always",
                    { decision: "acceptForSession", grantRoot: params.grantRoot ?? null },
                ),
                decision: "acceptForSession",
            },
            {
                option: permissionOption(ApprovalOptionId.RejectOnce, "Reject", "reject_once", { decision: "decline" }),
                decision: "decline",
            },
        ];
    }

    private rejectPermissionsResponse(): PermissionsRequestApprovalResponse {
        return {
            permissions: {},
            scope: "turn",
            strictAutoReview: true,
        };
    }

    private grantedPermissions(permissions: RequestPermissionProfile): GrantedPermissionProfile {
        return {
            ...(permissions.network ? { network: permissions.network } : {}),
            ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
        };
    }

    private networkPolicyAmendmentOptionId(index: number): string {
        return `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:${index}`;
    }

    private execpolicyAmendmentLabel(amendment: string[]): string {
        const commandPrefix = amendment.join(" ");
        if (!commandPrefix || commandPrefix.includes("\n") || commandPrefix.includes("\r")) {
            return "Allow and Remember Command Pattern";
        }
        return `Allow Commands Starting With \`${commandPrefix}\``;
    }

    private networkPolicyAmendmentLabel(amendment: NetworkPolicyAmendment): string {
        return amendment.action === "allow"
            ? `Allow ${amendment.host} in the Future`
            : `Block ${amendment.host} in the Future`;
    }

    private formatNetworkApprovalContext(params: CommandExecutionRequestApprovalParams): string | null {
        const context = params.networkApprovalContext;
        if (!context) return null;
        return `Network Approval Context: ${context.protocol} ${context.host}`;
    }

    private formatExecpolicyAmendment(params: CommandExecutionRequestApprovalParams): string | null {
        const amendment = params.proposedExecpolicyAmendment;
        if (!amendment || amendment.length === 0) return null;
        return `Proposed Command Pattern: ${amendment.join(" ")}`;
    }

    private formatNetworkPolicyAmendments(params: CommandExecutionRequestApprovalParams): string | null {
        const amendments = params.proposedNetworkPolicyAmendments;
        if (!amendments || amendments.length === 0) return null;
        return `Proposed Network Policy Amendments: ${amendments
            .map((amendment) => `${amendment.action} ${amendment.host}`)
            .join(", ")}`;
    }

    private formatRequestedPermissions(permissions: RequestPermissionProfile): string | null {
        const content: string[] = [];
        if (permissions.network?.enabled !== undefined && permissions.network.enabled !== null) {
            content.push(`Network Access: ${permissions.network.enabled}`);
        }
        if (permissions.fileSystem?.read?.length) {
            content.push(`File System Read Access: ${permissions.fileSystem.read.join(", ")}`);
        }
        if (permissions.fileSystem?.write?.length) {
            content.push(`File System Write Access: ${permissions.fileSystem.write.join(", ")}`);
        }
        if (permissions.fileSystem?.entries?.length) {
            content.push(`File System Entries: ${JSON.stringify(permissions.fileSystem.entries)}`);
        }
        return content.length > 0 ? content.join("\n\n") : null;
    }

    private createContent(lines: Array<string | null | undefined>): acp.ToolCallContent[] | undefined {
        const text = lines.filter((line): line is string => !!line).join("\n\n");
        if (!text) return undefined;
        return [{
            type: "content",
            content: {
                type: "text",
                text,
            },
        }];
    }
}
