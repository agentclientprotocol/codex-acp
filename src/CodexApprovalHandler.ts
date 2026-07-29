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
import type {AcpClientConnection} from "./ACPSessionConnection";

type CommandDecisionOption = {
    option: acp.PermissionOption;
    decision: CommandExecutionApprovalDecision;
};

type FileChangeDecisionOption = {
    option: acp.PermissionOption;
    decision: FileChangeApprovalDecision;
};

type PermissionMetadata = {
    version: 1;
    changes: Array<Record<string, unknown>>;
};

function permissionOption(
    optionId: string,
    name: string,
    kind: acp.PermissionOptionKind,
    codexMeta?: Record<string, unknown>,
    permission?: PermissionMetadata,
): acp.PermissionOption {
    return {
        optionId,
        name,
        kind,
        ...((codexMeta || permission) ? {
            _meta: {
                ...(permission ? {permission} : {}),
                ...(codexMeta ? {codex: codexMeta} : {}),
            },
        } : {}),
    };
}

export class CodexApprovalHandler implements ApprovalHandler {
    private readonly connection: AcpClientConnection;
    private readonly sessionState: SessionState;
    private readonly cancellationSignal: AbortSignal | undefined;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        cancellationSignal?: AbortSignal,
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
        this.cancellationSignal = cancellationSignal;
    }

    async handleCommandExecution(
        params: CommandExecutionRequestApprovalParams
    ): Promise<CommandExecutionRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildCommandPermissionRequest(sessionId, params);
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                acpRequest,
                this.requestOptions(),
            );
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
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                acpRequest,
                this.requestOptions(),
            );
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
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                acpRequest,
                this.requestOptions(),
            );
            return this.convertPermissionsResponse(params, response);
        } catch (error) {
            logger.error("Error requesting permissions", error);
            return this.rejectPermissionsResponse();
        }
    }

    private requestOptions(): acp.SendRequestOptions | undefined {
        return this.cancellationSignal ? {cancellationSignal: this.cancellationSignal} : undefined;
    }

    private buildCommandPermissionRequest(
        sessionId: string,
        params: CommandExecutionRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const options = this.buildCommandOptions(params).map(({ option }) => option);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "execute",
                status: "pending",
                rawInput: params.command ? { command: stripShellPrefix(params.command), cwd: params.cwd } : null,
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
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "edit",
                status: "pending",
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
                    this.permissionGrantMetadata(params.permissions, "session"),
                ),
                permissionOption(
                    ApprovalOptionId.AllowPermissionsForTurn,
                    "Allow Once",
                    "allow_once",
                    { decision: "allowPermissionsForTurn", permissions: params.permissions },
                    this.permissionGrantMetadata(params.permissions, "turn"),
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
                    params.networkApprovalContext ? {
                        version: 1,
                        changes: [{
                            type: "grant",
                            operation: "grant",
                            description: `Allow access to ${params.networkApprovalContext.host} for this session`,
                            lifetime: {scope: "session"},
                            targets: [{
                                type: "network",
                                matcher: {
                                    type: "host",
                                    host: params.networkApprovalContext.host,
                                    protocol: params.networkApprovalContext.protocol,
                                },
                            }],
                        }],
                    } : undefined,
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
                    {
                        version: 1,
                        changes: [{
                            type: "policy_rule",
                            operation: "add",
                            ruleBehavior: "allow",
                            description: `Allow commands starting with ${params.proposedExecpolicyAmendment.join(" ")}`,
                            targets: [{
                                type: "command",
                                matcher: {
                                    type: "argv_prefix",
                                    argv: params.proposedExecpolicyAmendment,
                                },
                            }],
                        }],
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
                    {
                        version: 1,
                        changes: [{
                            type: "policy_rule",
                            operation: "add",
                            ruleBehavior: amendment.action,
                            description: amendment.action === "allow"
                                ? `Allow access to ${amendment.host}`
                                : `Block access to ${amendment.host}`,
                            targets: [{
                                type: "network",
                                matcher: {
                                    type: "host",
                                    host: amendment.host,
                                },
                            }],
                        }],
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
                    params.grantRoot ? {
                        version: 1,
                        changes: [{
                            type: "grant",
                            operation: "grant",
                            description: `Allow writes under ${params.grantRoot} for this session`,
                            lifetime: {scope: "session"},
                            targets: [{
                                type: "filesystem",
                                access: ["write"],
                                matcher: {type: "directory", path: params.grantRoot},
                            }],
                        }],
                    } : undefined,
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

    private permissionGrantMetadata(
        permissions: RequestPermissionProfile,
        scope: "turn" | "session",
    ): PermissionMetadata | undefined {
        const changes: Array<Record<string, unknown>> = [];
        const lifetime = {scope};
        const suffix = scope === "session" ? " for this session" : " for this turn";

        if (permissions.network?.enabled !== null && permissions.network?.enabled !== undefined) {
            const allowed = permissions.network.enabled;
            changes.push({
                type: allowed ? "grant" : "policy_rule",
                operation: allowed ? "grant" : "add",
                ...(allowed ? {} : {ruleBehavior: "deny"}),
                description: `${allowed ? "Allow" : "Deny"} network access${suffix}`,
                lifetime,
                targets: [{type: "network", matcher: {type: "any"}}],
            });
        }

        const fileSystem = permissions.fileSystem;
        for (const path of fileSystem?.read ?? []) {
            changes.push(this.fileSystemGrantChange(path, "read", lifetime, suffix));
        }
        for (const path of fileSystem?.write ?? []) {
            changes.push(this.fileSystemGrantChange(path, "write", lifetime, suffix));
        }
        for (const entry of fileSystem?.entries ?? []) {
            const matcher = (() => {
                switch (entry.path.type) {
                    case "path":
                        return {type: "exact_path", path: entry.path.path};
                    case "glob_pattern":
                        return {type: "glob", pattern: entry.path.pattern};
                    case "special":
                        return {type: "special", provider: "codex", value: entry.path.value};
                }
            })();
            const pathDescription = entry.path.type === "path"
                ? entry.path.path
                : entry.path.type === "glob_pattern" ? entry.path.pattern : JSON.stringify(entry.path.value);
            changes.push({
                type: entry.access === "deny" ? "policy_rule" : "grant",
                operation: entry.access === "deny" ? "add" : "grant",
                ...(entry.access === "deny" ? {ruleBehavior: "deny"} : {}),
                description: entry.access === "deny"
                    ? `Deny filesystem access to ${pathDescription}${suffix}`
                    : `Allow ${entry.access} access to ${pathDescription}${suffix}`,
                lifetime,
                targets: [{
                    type: "filesystem",
                    ...(entry.access === "deny" ? {} : {access: [entry.access]}),
                    matcher,
                }],
            });
        }

        return changes.length > 0 ? {version: 1, changes} : undefined;
    }

    private fileSystemGrantChange(
        path: string,
        access: "read" | "write",
        lifetime: {scope: "turn" | "session"},
        suffix: string,
    ): Record<string, unknown> {
        return {
            type: "grant",
            operation: "grant",
            description: `Allow ${access} access to ${path}${suffix}`,
            lifetime,
            targets: [{
                type: "filesystem",
                access: [access],
                matcher: {type: "exact_path", path},
            }],
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
