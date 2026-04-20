import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    FileUpdateChange,
} from "./app-server/v2";
import type {ToolCallContent} from "@agentclientprotocol/sdk/dist/schema/types.gen";
import {logger} from "./Logger";
import {stripShellPrefix} from "./CodexEventHandler";
import type {ApprovalContextStore} from "./CodexApprovalContext";
import {
    createFileChangeContents,
    createFileChangeLocations,
    createRawFileChangeInput,
    parseUnifiedDiffChanges,
} from "./CodexToolCallMapper";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

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

    private async buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): Promise<acp.RequestPermissionRequest> {
        const reasonContent = this.createTextContent(params.reason ?? null);
        const fileChange = this.approvalContext.fileChangesByItemId.get(params.itemId);
        const content: ToolCallContent[] = reasonContent ? [reasonContent] : [];
        const toolCall: acp.ToolCallUpdate = {
            toolCallId: params.itemId,
            kind: "edit",
            status: "pending",
        };
        if (fileChange) {
            content.push(...await createFileChangeContents(fileChange.changes));
            toolCall.locations = createFileChangeLocations(fileChange.changes);
            toolCall.rawInput = createRawFileChangeInput(fileChange.changes);
        } else {
            const turnDiff = this.approvalContext.turnDiffsByTurnId.get(params.turnId);
            if (turnDiff) {
                const parsedChanges = parseUnifiedDiffChanges(turnDiff);
                content.push(...await createFileChangeContents(parsedChanges));
                const locations = createFileChangeLocations(parsedChanges);
                if (locations.length > 0) {
                    toolCall.locations = locations;
                }
                toolCall.rawInput = parsedChanges.length > 0
                    ? { unifiedDiff: turnDiff, ...createRawFileChangeInput(parsedChanges) }
                    : { unifiedDiff: turnDiff };
            }
        }
        if (content.length > 0) {
            toolCall.content = content;
        }
        return {
            sessionId,
            toolCall,
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
}
