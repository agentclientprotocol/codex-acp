import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    AdditionalFileSystemPermissions,
    AdditionalNetworkPermissions,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    GrantedPermissionProfile,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
} from "./app-server/v2";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {ToolCallContent} from "@agentclientprotocol/sdk/dist/schema/types.gen";
import {logger} from "./Logger";
import {stripShellPrefix} from "./CommandUtils";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

type McpElicitationOption = {
    option: acp.PermissionOption;
    action: "accept" | "cancel";
    meta: JsonValue | null;
};

type McpFormElicitationRequestParams = Extract<McpServerElicitationRequestParams, { mode: "form" }>;

const MCP_TOOL_APPROVAL_KIND_KEY = "codex_approval_kind";
const MCP_TOOL_APPROVAL_KIND_MCP_TOOL_CALL = "mcp_tool_call";
const MCP_TOOL_APPROVAL_PERSIST_KEY = "persist";
const MCP_TOOL_APPROVAL_PERSIST_SESSION = "session";
const MCP_TOOL_APPROVAL_PERSIST_ALWAYS = "always";
const MCP_TOOL_APPROVAL_TOOL_TITLE_KEY = "tool_title";
const MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY = "tool_description";
const MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY = "connector_name";
const MCP_TOOL_APPROVAL_CONNECTOR_DESCRIPTION_KEY = "connector_description";
const MCP_TOOL_APPROVAL_TOOL_PARAMS_KEY = "tool_params";
const MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY = "tool_params_display";
const MCP_TOOL_APPROVAL_ALLOW_OPTION_ID = "approved";
const MCP_TOOL_APPROVAL_ALLOW_SESSION_OPTION_ID = "approved-for-session";
const MCP_TOOL_APPROVAL_ALLOW_ALWAYS_OPTION_ID = "approved-always";
const MCP_TOOL_APPROVAL_CANCEL_OPTION_ID = "cancel";

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

    async handlePermissionsRequest(
        params: PermissionsRequestApprovalParams
    ): Promise<PermissionsRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildPermissionsApprovalRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertPermissionsResponse(response, params);
        } catch (error) {
            logger.error("Error requesting additional permissions", error);
            return { permissions: {}, scope: "turn" };
        }
    }

    async handleMcpElicitation(
        params: McpServerElicitationRequestParams
    ): Promise<McpServerElicitationRequestResponse> {
        try {
            const approvalKind = this.getStringMetaField(params._meta, MCP_TOOL_APPROVAL_KIND_KEY);
            if (approvalKind !== MCP_TOOL_APPROVAL_KIND_MCP_TOOL_CALL) {
                logger.log("Unsupported MCP elicitation kind", { approvalKind, serverName: params.serverName });
                return { action: "decline", content: null, _meta: null };
            }

            if (params.mode !== "form") {
                logger.log("Unsupported MCP elicitation mode for tool approval", { mode: params.mode, serverName: params.serverName });
                return { action: "decline", content: null, _meta: null };
            }

            const formParams = params;

            const options = this.extractMcpApprovalOptions(formParams);
            if (options.length === 0) {
                logger.log("MCP elicitation approval did not contain supported selectable options", { serverName: params.serverName });
                return { action: "cancel", content: null, _meta: null };
            }

            const sessionId = this.sessionState.sessionId;
            const response = await this.connection.requestPermission({
                sessionId,
                toolCall: {
                    toolCallId: this.buildMcpElicitationToolCallId(params, options),
                    kind: "execute",
                    status: "pending",
                    title: this.buildMcpElicitationTitle(formParams),
                    content: [this.createContentFromReason(this.createMcpElicitationMessage(formParams))].filter((content): content is ToolCallContent => content !== null),
                    rawInput: {
                        server: params.serverName,
                        kind: "mcp_tool_call",
                        request: formParams,
                    },
                },
                options: options.map(({ option }) => option),
            });

            return this.convertMcpElicitationResponse(response, options);
        } catch (error) {
            logger.error("Error requesting MCP elicitation approval", error);
            return { action: "cancel", content: null, _meta: null };
        }
    }

    private buildCommandPermissionRequest(
        sessionId: string,
        params: CommandExecutionRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const reasonContent = this.createContentFromReason(params.reason ?? null);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "execute",
                status: "pending",
                content: reasonContent ? [reasonContent] : null,
                rawInput: params.command ? { command: stripShellPrefix(params.command), cwd: params.cwd } : null,
            },
            options: APPROVAL_OPTIONS,
        };
    }

    private createContentFromReason(reason: string | null): ToolCallContent | null {
        if (reason === null || reason === "") {
            return null;
        }
        return {
            type: "content",
            content: {
                type: "text",
                text: reason
            }
        }
    }

    private buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const reasonContent = this.createContentFromReason(params.reason ?? null);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "edit",
                status: "pending",
                content: reasonContent ? [reasonContent] : null,
            },
            options: APPROVAL_OPTIONS,
        };
    }

    private buildPermissionsApprovalRequest(
        sessionId: string,
        params: PermissionsRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const content = this.createPermissionsContent(params);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: params.permissions.network ? "fetch" : "execute",
                status: "pending",
                content: content ? [content] : null,
                rawInput: params.permissions,
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
            return { decision: "cancel" };
        }
    }

    private convertPermissionsResponse(
        response: acp.RequestPermissionResponse,
        params: PermissionsRequestApprovalParams
    ): PermissionsRequestApprovalResponse {
        if (response.outcome.outcome !== "selected") {
            return { permissions: {}, scope: "turn" };
        }

        if (response.outcome.optionId === "allow_once") {
            return {
                permissions: this.createGrantedPermissions(params),
                scope: "turn",
            };
        }

        if (response.outcome.optionId === "allow_always") {
            return {
                permissions: this.createGrantedPermissions(params),
                scope: "session",
            };
        }

        return { permissions: {}, scope: "turn" };
    }

    private createGrantedPermissions(params: PermissionsRequestApprovalParams): GrantedPermissionProfile {
        const permissions: GrantedPermissionProfile = {};
        if (params.permissions.network !== null) {
            permissions.network = this.cloneNetworkPermissions(params.permissions.network);
        }
        if (params.permissions.fileSystem !== null) {
            permissions.fileSystem = this.cloneFileSystemPermissions(params.permissions.fileSystem);
        }
        return permissions;
    }

    private createPermissionsContent(params: PermissionsRequestApprovalParams): ToolCallContent | null {
        const lines: string[] = [];
        if (params.reason) {
            lines.push(params.reason);
        }

        const permissionsSummary = this.describeRequestedPermissions(params);
        if (permissionsSummary.length > 0) {
            lines.push(`Requested permissions: ${permissionsSummary.join("; ")}`);
        }

        if (lines.length === 0) {
            return null;
        }

        return {
            type: "content",
            content: {
                type: "text",
                text: lines.join("\n"),
            },
        };
    }

    private describeRequestedPermissions(params: PermissionsRequestApprovalParams): Array<string> {
        const parts: string[] = [];
        const network = params.permissions.network;
        if (network?.enabled) {
            parts.push("network access");
        }

        const fileSystem = params.permissions.fileSystem;
        if (fileSystem?.read?.length) {
            parts.push(`read ${fileSystem.read.join(", ")}`);
        }
        if (fileSystem?.write?.length) {
            parts.push(`write ${fileSystem.write.join(", ")}`);
        }

        return parts;
    }

    private cloneNetworkPermissions(permissions: AdditionalNetworkPermissions): AdditionalNetworkPermissions {
        return {
            enabled: permissions.enabled,
        };
    }

    private cloneFileSystemPermissions(permissions: AdditionalFileSystemPermissions): AdditionalFileSystemPermissions {
        return {
            read: permissions.read ? [...permissions.read] : null,
            write: permissions.write ? [...permissions.write] : null,
        };
    }

    private getStringMetaField(meta: JsonValue | null, field: string): string | null {
        if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
            return null;
        }
        const value = meta[field];
        return typeof value === "string" ? value : null;
    }

    private createMcpElicitationMessage(params: McpServerElicitationRequestParams): string {
        if (params.mode !== "form") {
            return params.message;
        }
        const meta = this.getMetaObject(params._meta);
        const sections = [params.message.trim()];

        const source = this.getNonEmptyString(meta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY)
            ? `Source: ${this.getNonEmptyString(meta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY)}`
            : `Server: ${params.serverName}`;
        sections.push(source);

        const connectorDescription = this.getNonEmptyString(meta, MCP_TOOL_APPROVAL_CONNECTOR_DESCRIPTION_KEY);
        if (connectorDescription) {
            sections.push(connectorDescription);
        }

        const toolDescription = this.getNonEmptyString(meta, MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY);
        if (toolDescription) {
            sections.push(toolDescription);
        }

        const formattedParams = this.formatMcpToolApprovalParams(meta);
        if (formattedParams) {
            sections.push(`Arguments:\n${formattedParams}`);
        }

        return sections.filter(Boolean).join("\n\n");
    }

    private buildMcpElicitationTitle(params: McpFormElicitationRequestParams): string {
        const meta = this.getMetaObject(params._meta);
        const toolTitle = this.getNonEmptyString(meta, MCP_TOOL_APPROVAL_TOOL_TITLE_KEY);
        if (toolTitle) {
            return `Approve ${toolTitle}`;
        }
        return "Approve MCP tool call";
    }

    private buildMcpElicitationToolCallId(
        params: McpServerElicitationRequestParams,
        _options: McpElicitationOption[]
    ): string {
        return `mcp-elicitation:${params.serverName}:${params.turnId ?? "no-turn"}`;
    }

    private readPersistOptions(meta: JsonValue | null): string[] {
        if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
            return [];
        }

        const persist = meta["persist"];
        if (typeof persist === "string") {
            return [persist];
        }
        if (Array.isArray(persist)) {
            return persist.filter((value): value is string => typeof value === "string");
        }
        return [];
    }

    private extractMcpApprovalOptions(params: McpFormElicitationRequestParams): McpElicitationOption[] {
        const persist = this.readPersistOptions(params._meta);
        const options: McpElicitationOption[] = [{
            option: {
                optionId: MCP_TOOL_APPROVAL_ALLOW_OPTION_ID,
                name: "Allow",
                kind: "allow_once",
            },
            action: "accept",
            meta: null,
        }];

        if (persist.includes(MCP_TOOL_APPROVAL_PERSIST_SESSION)) {
            options.push({
                option: {
                    optionId: MCP_TOOL_APPROVAL_ALLOW_SESSION_OPTION_ID,
                    name: "Allow for Session",
                    kind: "allow_always",
                },
                action: "accept",
                meta: { persist: MCP_TOOL_APPROVAL_PERSIST_SESSION },
            });
        }

        if (persist.includes(MCP_TOOL_APPROVAL_PERSIST_ALWAYS)) {
            options.push({
                option: {
                    optionId: MCP_TOOL_APPROVAL_ALLOW_ALWAYS_OPTION_ID,
                    name: "Allow and Don't Ask Again",
                    kind: "allow_always",
                },
                action: "accept",
                meta: { persist: MCP_TOOL_APPROVAL_PERSIST_ALWAYS },
            });
        }

        options.push({
            option: {
                optionId: MCP_TOOL_APPROVAL_CANCEL_OPTION_ID,
                name: "Cancel",
                kind: "reject_once",
            },
            action: "cancel",
            meta: null,
        });

        return options;
    }

    private convertMcpElicitationResponse(
        response: acp.RequestPermissionResponse,
        options: McpElicitationOption[]
    ): McpServerElicitationRequestResponse {
        if (response.outcome.outcome !== "selected") {
            return { action: "cancel", content: null, _meta: null };
        }

        const selectedOptionId = response.outcome.optionId;
        const selected = options.find(option => option.option.optionId === selectedOptionId);
        if (!selected) {
            logger.log("Unknown MCP elicitation selection returned from ACP", { optionId: selectedOptionId });
            return { action: "cancel", content: null, _meta: null };
        }

        if (selected.action === "cancel") {
            return { action: "cancel", content: null, _meta: null };
        }

        return {
            action: "accept",
            content: null,
            _meta: selected.meta,
        };
    }

    private getMetaObject(meta: JsonValue | null): Record<string, JsonValue> | null {
        if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
            return null;
        }
        return meta as Record<string, JsonValue>;
    }

    private getNonEmptyString(meta: Record<string, JsonValue> | null, key: string): string | null {
        if (!meta) {
            return null;
        }
        const value = meta[key];
        return typeof value === "string" && value.trim().length > 0 ? value : null;
    }

    private formatMcpToolApprovalParams(meta: Record<string, JsonValue> | null): string | null {
        if (!meta) {
            return null;
        }

        const paramsDisplay = meta[MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY];
        if (Array.isArray(paramsDisplay)) {
            const rendered = paramsDisplay.flatMap(param => {
                if (!param || typeof param !== "object" || Array.isArray(param)) {
                    return [];
                }
                const object = param as Record<string, JsonValue>;
                const name = (typeof object["display_name"] === "string" && object["display_name"])
                    || (typeof object["name"] === "string" && object["name"]);
                if (!name || object["value"] === undefined) {
                    return [];
                }
                return [`- ${name}: ${this.formatMcpToolApprovalValue(object["value"])}`];
            });
            if (rendered.length > 0) {
                return rendered.join("\n");
            }
        }

        const params = meta[MCP_TOOL_APPROVAL_TOOL_PARAMS_KEY];
        if (params === undefined) {
            return null;
        }
        if (typeof params === "string") {
            return params;
        }
        try {
            return JSON.stringify(params, null, 2);
        } catch {
            return String(params);
        }
    }

    private formatMcpToolApprovalValue(value: JsonValue): string {
        if (typeof value === "string") {
            return value;
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
}
