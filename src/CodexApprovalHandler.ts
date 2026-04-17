import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    FileUpdateChange,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse
} from "./app-server/v2";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {ToolCallContent} from "@agentclientprotocol/sdk/dist/schema/types.gen";
import {logger} from "./Logger";
import {stripShellPrefix} from "./CodexEventHandler";
import type {ApprovalContextStore} from "./CodexApprovalContext";
import {createFileChangeContents} from "./CodexToolCallMapper";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

const ELICITATION_ALLOW_ONCE_OPTION_ID = "allow_once";
const ELICITATION_ALLOW_SESSION_OPTION_ID = "allow_for_session";
const ELICITATION_ALLOW_ALWAYS_OPTION_ID = "allow_always";
const ELICITATION_DENY_ONCE_OPTION_ID = "deny_once";

type ElicitationPersistOption = "session" | "always";
type JsonObject = { [key: string]: JsonValue };

export class CodexApprovalHandler implements ApprovalHandler {
    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
    private readonly approvalContext: ApprovalContextStore;

    constructor(
        connection: acp.AgentSideConnection,
        sessionState: SessionState,
        approvalContext: ApprovalContextStore,
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
        this.approvalContext = approvalContext;
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
            const acpRequest = await this.buildFileChangePermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertFileChangeResponse(response);
        } catch (error) {
            logger.error("Error requesting file change permission", error);
            return { decision: "cancel" };
        }
    }

    async handleMcpServerElicitation(
        params: McpServerElicitationRequestParams
    ): Promise<McpServerElicitationRequestResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildMcpServerElicitationPermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertMcpServerElicitationResponse(params, response);
        } catch (error) {
            logger.error("Error requesting MCP server elicitation approval", error);
            return this.createCancelledMcpServerElicitationResponse();
        }
    }

    private buildCommandPermissionRequest(
        sessionId: string,
        params: CommandExecutionRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const reasonContent = this.createTextContent(params.reason ?? null);
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

    private createTextContent(text: string | null): ToolCallContent | null {
        if (text === null || text === "") {
            return null;
        }
        return {
            type: "content",
            content: {
                type: "text",
                text
            }
        }
    }

    private createTextContents(...texts: Array<string | null | undefined>): Array<ToolCallContent> | null {
        const contents = texts
            .map(text => this.createTextContent(text ?? null))
            .filter((content): content is ToolCallContent => content !== null)
        return contents.length > 0 ? contents : null
    }

    private async buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): Promise<acp.RequestPermissionRequest> {
        const reasonContent = this.createTextContent(params.reason ?? null);
        const fileChange = this.approvalContext.fileChangesByItemId.get(params.itemId);
        const diffContent = fileChange ? await createFileChangeContents(fileChange.changes) : [];
        const toolCall: acp.ToolCallUpdate = {
            toolCallId: params.itemId,
            kind: "edit",
            status: "pending",
        };
        const content = [
            ...(reasonContent ? [reasonContent] : []),
            ...diffContent,
        ];
        if (content.length > 0) {
            toolCall.content = content;
        }
        if (fileChange) {
            toolCall.locations = dedupePaths(fileChange.changes).map(path => ({ path }));
            toolCall.rawInput = {
                changes: fileChange.changes.map(change => ({
                    path: change.path,
                    kind: change.kind.type,
                    diff: change.diff,
                })),
            };
        } else {
            const turnDiff = this.approvalContext.turnDiffsByTurnId.get(params.turnId);
            if (turnDiff) {
                toolCall.rawInput = { unifiedDiff: turnDiff };
            }
        }
        return {
            sessionId,
            toolCall,
            options: APPROVAL_OPTIONS,
        };
    }

    private buildMcpServerElicitationPermissionRequest(
        sessionId: string,
        params: McpServerElicitationRequestParams
    ): acp.RequestPermissionRequest {
        const meta = this.asRecord(params._meta);
        const persist = meta?.["persist"];
        const persistOptions = (Array.isArray(persist) ? persist : [persist]).filter(
            (value): value is ElicitationPersistOption => value === "session" || value === "always"
        );
        const toolDescription = typeof meta?.["tool_description"] === "string"
            ? meta["tool_description"]
            : null;
        const rawInput = this.tryToJsonValue(meta?.["tool_params"]) ?? null;

        return {
            sessionId,
            toolCall: {
                toolCallId: this.buildMcpServerElicitationToolCallId(params),
                title: params.message !== "" ? params.message : "MCP permission request",
                kind: "other",
                status: "pending",
                content: this.createTextContents(toolDescription),
                rawInput,
            },
            options: this.buildMcpServerElicitationOptions(persistOptions),
        };
    }

    private buildMcpServerElicitationToolCallId(
        params: McpServerElicitationRequestParams
    ): string {
        return `mcp-elicitation:${params.serverName}:${params.turnId ?? params.threadId}:${params.mode}`;
    }

    private buildMcpServerElicitationOptions(
        persistOptions: Array<ElicitationPersistOption>
    ): Array<acp.PermissionOption> {
        const options: Array<acp.PermissionOption> = [
            { optionId: ELICITATION_ALLOW_ONCE_OPTION_ID, name: "Allow Once", kind: "allow_once" },
        ]

        if (persistOptions.includes("session")) {
            options.push({
                optionId: ELICITATION_ALLOW_SESSION_OPTION_ID,
                name: "Allow for Session",
                kind: "allow_always",
            })
        }

        if (persistOptions.includes("always")) {
            options.push({
                optionId: ELICITATION_ALLOW_ALWAYS_OPTION_ID,
                name: "Always Allow",
                kind: "allow_always",
            })
        }

        options.push({
            optionId: ELICITATION_DENY_ONCE_OPTION_ID,
            name: "Deny Once",
            kind: "reject_once",
        })

        return options
    }

    private asRecord(value: unknown): Record<string, unknown> | null {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return null
        }
        return value as Record<string, unknown>
    }

    private tryToJsonValue(value: unknown): JsonValue | undefined {
        if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        ) {
            return value
        }

        if (Array.isArray(value)) {
            const convertedValues: Array<JsonValue> = []
            for (const item of value) {
                const convertedItem = this.tryToJsonValue(item)
                if (convertedItem === undefined) {
                    return undefined
                }
                convertedValues.push(convertedItem)
            }
            return convertedValues
        }

        if (typeof value === "object") {
            const record = value as Record<string, unknown>
            const jsonObject: JsonObject = {}
            for (const [key, nestedValue] of Object.entries(record)) {
                const convertedValue = this.tryToJsonValue(nestedValue)
                if (convertedValue === undefined) {
                    return undefined
                }
                jsonObject[key] = convertedValue
            }
            return jsonObject
        }

        return undefined
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

    private convertMcpServerElicitationResponse(
        params: McpServerElicitationRequestParams,
        response: acp.RequestPermissionResponse
    ): McpServerElicitationRequestResponse {
        if (response.outcome.outcome === "cancelled") {
            return this.createCancelledMcpServerElicitationResponse();
        }

        switch (response.outcome.optionId) {
            case ELICITATION_ALLOW_ONCE_OPTION_ID:
                return this.createAcceptedMcpServerElicitationResponse(params, null);
            case ELICITATION_ALLOW_SESSION_OPTION_ID:
                return this.createAcceptedMcpServerElicitationResponse(params, { persist: "session" });
            case ELICITATION_ALLOW_ALWAYS_OPTION_ID:
                return this.createAcceptedMcpServerElicitationResponse(params, { persist: "always" });
            case ELICITATION_DENY_ONCE_OPTION_ID:
            case "reject_once":
                return { action: "decline", content: null, _meta: null };
            default:
                return this.createCancelledMcpServerElicitationResponse();
        }
    }

    private createAcceptedMcpServerElicitationResponse(
        params: McpServerElicitationRequestParams,
        meta: JsonObject | null
    ): McpServerElicitationRequestResponse {
        return {
            action: "accept",
            content: params.mode === "form" ? {} : null,
            _meta: meta,
        }
    }

    private createCancelledMcpServerElicitationResponse(): McpServerElicitationRequestResponse {
        return { action: "cancel", content: null, _meta: null }
    }
}

function dedupePaths(changes: Array<FileUpdateChange>): Array<string> {
    return Array.from(new Set(changes.map(change => change.path)));
}
