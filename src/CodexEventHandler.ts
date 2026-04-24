import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
    McpStartupCompleteEvent,
    ServerNotification
} from "./app-server";
import type {SessionState} from "./CodexAcpServer";
import * as acp from "@agentclientprotocol/sdk";
import {type PlanEntry, RequestError} from "@agentclientprotocol/sdk";
import type {ToolCallContent} from "@agentclientprotocol/sdk/dist/schema/types.gen";
import {ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AccountRateLimitsUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    CommandExecutionOutputDeltaNotification,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    ConfigWarningNotification,
    ErrorNotification,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    ItemCompletedNotification,
    ItemStartedNotification,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    ModelReroutedNotification,
    ThreadItem,
    ThreadTokenUsageUpdatedNotification,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import {stripShellPrefix} from "./CommandUtils";
import {logger} from "./Logger";
import {toTokenCount} from "./TokenCount";
import {
    createCommandExecutionUpdate,
    createDynamicToolCallUpdate,
    createFileChangeCompletionUpdate,
    createFileChangeContents,
    createFileChangeLocations,
    createFileChangeUpdate,
    createFuzzyFileSearchComplete,
    createFuzzyFileSearchStartOrUpdate,
    createMcpRawInput,
    createMcpRawOutput,
    createMcpToolCallUpdate,
    createRawFileChangeInput,
    fuzzyFileSearchToolCallId,
    parseUnifiedDiffChanges,
} from "./CodexToolCallMapper";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

// Standard elicitation options (non-tool-call approval).
const ELICITATION_OPTIONS: acp.PermissionOption[] = [
    { optionId: "accept", name: "Accept", kind: "allow_once" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
];

// Option IDs used for MCP tool call approval persist choices.
const OPTION_ALLOW_ONCE = "allow_once";
const OPTION_ALLOW_SESSION = "allow_session";
const OPTION_ALLOW_ALWAYS = "allow_always";

type PersistValue = "session" | "always";

/**
 * Parses the `persist` field from the elicitation request `_meta`.
 * Codex advertises which persistence options the client should show.
 * Returns a set of supported persist values.
 */
function parsePersistOptions(meta: unknown): Set<PersistValue> {
    const result = new Set<PersistValue>();
    if (!meta || typeof meta !== "object") {
        return result;
    }

    const persist = (meta as Record<string, unknown>)["persist"];
    if (persist === "session") {
        result.add("session");
    } else if (persist === "always") {
        result.add("always");
    } else if (Array.isArray(persist)) {
        if (persist.includes("session")) {
            result.add("session");
        }
        if (persist.includes("always")) {
            result.add("always");
        }
    }
    return result;
}

function isMcpToolCallApproval(meta: unknown): boolean {
    return meta !== null
        && typeof meta === "object"
        && (meta as Record<string, unknown>)["codex_approval_kind"] === "mcp_tool_call";
}

/**
 * Builds the ACP permission options for an MCP tool call approval elicitation.
 * Always includes "Allow Once"; adds session/always persist options when advertised.
 */
function buildToolApprovalOptions(persistOptions: Set<PersistValue>): acp.PermissionOption[] {
    const options: acp.PermissionOption[] = [
        { optionId: OPTION_ALLOW_ONCE, name: "Allow", kind: "allow_once" },
    ];
    if (persistOptions.has("session")) {
        options.push({ optionId: OPTION_ALLOW_SESSION, name: "Allow for This Session", kind: "allow_always" });
    }
    if (persistOptions.has("always")) {
        options.push({ optionId: OPTION_ALLOW_ALWAYS, name: "Allow and Don't Ask Again", kind: "allow_always" });
    }
    options.push({ optionId: "decline", name: "Decline", kind: "reject_once" });
    return options;
}

export class CodexEventHandler {

    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
    private readonly fileChangesByItemId = new Map<string, ThreadItem & { type: "fileChange" }>();
    private readonly turnDiffsByTurnId = new Map<string, string>();
    // In Rust, the MCP elicitation handler receives ElicitationRequestEvent directly from the MCP
    // protocol layer, where id is set to "mcp_tool_call_approval_<call_id>" — the call ID is extracted
    // by stripping that prefix.
    //
    // In TypeScript, Codex speaks the app-server JSON-RPC protocol (v2), where
    // McpServerElicitationRequestParams omits elicitationId for form mode, so the MCP-level ID never
    // reaches the client.
    //
    // Workaround: before requesting approval, Codex emits an item/started notification with an
    // mcpToolCall item carrying the call id and server name. We store (threadId, serverName) → callId
    // here so the elicitation request can correlate back to the already-rendered tool call item.
    //
    // Multiple calls are safe because Codex requests approval synchronously — it blocks on one tool
    // call's elicitation before starting the next, so there is at most one pending approval per
    // (threadId, serverName).
    private readonly pendingMcpApprovals = new Map<string, string>();
    private failure: RequestError | null = null;
    private readonly activeFuzzyFileSearchSessions = new Set<string>();

    constructor(connection: acp.AgentSideConnection, sessionState: SessionState) {
        this.connection = connection;
        this.sessionState = sessionState;
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    async handleNotification(notification: ServerNotification): Promise<void> {
        const session = new ACPSessionConnection(this.connection, this.sessionState.sessionId);
        const updateEvent = await this.createUpdateEvent(notification);
        if (updateEvent) {
            await session.update(updateEvent);
        }
    }

    async handleCommandExecution(
        params: CommandExecutionRequestApprovalParams
    ): Promise<CommandExecutionRequestApprovalResponse> {
        try {
            const response = await this.connection.requestPermission(
                this.buildCommandPermissionRequest(this.sessionState.sessionId, params)
            );
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
            const response = await this.connection.requestPermission(
                await this.buildFileChangePermissionRequest(this.sessionState.sessionId, params)
            );
            return this.convertFileChangeResponse(response);
        } catch (error) {
            logger.error("Error requesting file change permission", error);
            return { decision: "cancel" };
        }
    }

    async handleElicitation(
        params: McpServerElicitationRequestParams
    ): Promise<McpServerElicitationRequestResponse> {
        try {
            const { request, correlatedCallId } = this.buildElicitationPermissionRequest(params);
            const response = await this.connection.requestPermission(request);
            if (correlatedCallId && response.outcome.outcome !== "cancelled" && response.outcome.optionId !== "decline") {
                await this.connection.sessionUpdate({
                    sessionId: this.sessionState.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: correlatedCallId,
                        status: "in_progress",
                    }
                });
            }
            return this.convertElicitationResponse(response);
        } catch (error) {
            logger.error("Error handling MCP elicitation request", error);
            return { action: "cancel", content: null, _meta: null };
        }
    }

    private async createUpdateEvent(notification: ServerNotification): Promise<UpdateSessionEvent | null> {
        /*
        TODO split UpdateSessionEvent to improve completion
        createUpdateEvent({
            sessionUpdate: "" , <- completion of UpdateSessionEvent["sessionUpdate"]
            params: {}, <- quickfix to generate required fields (rest of)
        });
         */
        switch (notification.method) {
            case "item/agentMessage/delta":
                return await this.createTextEvent(notification.params);
            case "item/started":
                this.trackItemStarted(notification.params);
                return await this.createItemEvent(notification.params);
            case "item/completed":
                this.trackItemCompleted(notification.params);
                return await this.completeItemEvent(notification.params);
            case "turn/plan/updated":
                return await this.updatePlan(notification.params);
            case "error":
                return await this.createErrorEvent(notification.params);
            case "turn/started":
                this.sessionState.currentTurnId = notification.params.turn.id;
                return null;
            case "turn/completed":
                this.sessionState.currentTurnId = null;
                return null;
            case "thread/tokenUsage/updated":
                return this.createUsageUpdate(notification.params);
            case "item/commandExecution/outputDelta":
                return this.createCommandOutputDeltaEvent(notification.params);
            case "command/exec/outputDelta":
            case "item/autoApprovalReview/started":
            case "item/autoApprovalReview/completed":
            case "hook/started":
            case "hook/completed":
                return null;
            case "item/reasoning/summaryTextDelta":
            case "item/reasoning/summaryPartAdded":
            case "item/reasoning/textDelta":
            case "item/commandExecution/terminalInteraction":
            case "item/fileChange/outputDelta":
            case "account/updated":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
                return null;
            case "serverRequest/resolved":
                this.clearThreadApprovals(notification.params.threadId);
                return null;
            case "turn/diff/updated":
                this.turnDiffsByTurnId.set(notification.params.turnId, notification.params.diff);
                return null;
            case "item/mcpToolCall/progress":
                return this.createMcpToolProgressEvent(notification.params);
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "configWarning":
                return await this.createConfigWarningEvent(notification.params);
            case "warning":
                return this.createWarningEvent(notification.params);
            case "thread/compacted":
                return {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                        type: "text",
                        text: "*Context compacted to fit the model's context window.*\n\n"
                    }
                };
            case "windows/worldWritableWarning":
            case "thread/status/changed":
            case "thread/archived":
            case "thread/unarchived":
            case "thread/closed":
            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/transcript/delta":
            case "thread/realtime/transcript/done":
            case "thread/realtime/outputAudio/delta":
            case "thread/realtime/sdp":
            case "thread/realtime/error":
            case "thread/realtime/closed":
            case "windowsSandbox/setupCompleted":
            case "account/login/completed":
            case "skills/changed":
            case "deprecationNotice":
            case "mcpServer/oauthLogin/completed":
            case "externalAgentConfig/import/completed":
            case "rawResponseItem/completed":
            case "thread/started":
            case "thread/name/updated":
            case "item/plan/delta":
            case "app/list/updated":
                return null;
            case "model/rerouted":
                return this.createModelReroutedEvent(notification.params);
            case "fuzzyFileSearch/sessionUpdated":
                return this.handleFuzzyFileSearchSessionUpdated(notification.params);
            case "fuzzyFileSearch/sessionCompleted":
                return this.handleFuzzyFileSearchSessionCompleted(notification.params);
        }
    }

    private async createTextEvent(event: AgentMessageDeltaNotification): Promise<UpdateSessionEvent> {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: event.delta
            }
        };
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        const detailsText = event.details ? `\n\n${event.details}` : "";
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `Config warning: ${event.summary}${detailsText}\n\n`
            }
        };
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `Warning: ${event.message}\n\n`
            }
        };
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_thought_chunk",
            content: {
                type: "text",
                text: `Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`
            }
        };
    }

    private async createItemEvent(event: ItemStartedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
                this.fileChangesByItemId.set(event.item.id, event.item);
                return await createFileChangeUpdate(event.item);
            case "commandExecution":
                return await createCommandExecutionUpdate(event.item);
            case "mcpToolCall":
                return await createMcpToolCallUpdate(event.item);
            case "dynamicToolCall":
                return await createDynamicToolCallUpdate(event.item);
            case "collabAgentToolCall":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "reasoning":
            case "webSearch":
            case "imageView":
            case "imageGeneration":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "contextCompaction":
            case "plan":
                return null;
        }
    }

    private async completeItemEvent(event: ItemCompletedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
                this.fileChangesByItemId.set(event.item.id, event.item);
                return createFileChangeCompletionUpdate(event.item);
            case "dynamicToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed",
                };
            case "mcpToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed",
                    rawInput: createMcpRawInput(event.item.server, event.item.tool, event.item.arguments),
                    rawOutput: createMcpRawOutput(event.item.result, event.item.error),
                };
            case "commandExecution":
                return this.completeCommandExecutionEvent(event.item);
            case "reasoning": {
                const summary = event.item.summary[0];
                if (!summary) {
                    return null;
                }
                return {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                        type: "text",
                        text: summary
                    }
                };
            }
            case "collabAgentToolCall":
            case "userMessage":
            case "hookPrompt":
            case "agentMessage":
            case "webSearch":
            case "imageView":
            case "imageGeneration":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "contextCompaction":
            case "plan":
                return null;
        }
    }

    private createCommandOutputDeltaEvent(event: CommandExecutionOutputDeltaNotification): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: event.itemId,
            _meta: {
                terminal_output_delta: {
                    data: event.delta,
                    terminal_id: event.itemId
                }
            }
        };
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
        };
    }

    private async buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): Promise<acp.RequestPermissionRequest> {
        const reasonContent = this.createTextContent(params.reason ?? null);
        const fileChange = this.fileChangesByItemId.get(params.itemId);
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
            const turnDiff = this.turnDiffsByTurnId.get(params.turnId);
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

    private buildElicitationPermissionRequest(
        params: McpServerElicitationRequestParams
    ): { request: acp.RequestPermissionRequest; correlatedCallId: string | undefined } {
        const messageContent = this.createTextContent(params.message);
        const isToolApproval = isMcpToolCallApproval(params._meta);
        const options = isToolApproval
            ? buildToolApprovalOptions(parsePersistOptions(params._meta))
            : ELICITATION_OPTIONS;

        if (params.mode === "form") {
            const correlatedCallId = isToolApproval
                ? this.popPendingApproval(params.threadId, params.serverName)
                : undefined;
            if (correlatedCallId) {
                // The tool call item is already visible in the IDE conversation history because
                // item/started was emitted before the elicitation request. Sending content or
                // rawInput here would duplicate that information in the approval widget.
                return {
                    request: {
                        sessionId: this.sessionState.sessionId,
                        toolCall: {
                            toolCallId: correlatedCallId,
                            kind: "execute",
                            status: "pending",
                        },
                        _meta: { is_mcp_tool_approval: true },
                        options,
                    },
                    correlatedCallId,
                };
            }
            return {
                request: {
                    sessionId: this.sessionState.sessionId,
                    toolCall: {
                        toolCallId: `elicitation-${params.serverName}`,
                        kind: isToolApproval ? "execute" : "other",
                        status: "pending",
                        content: messageContent ? [messageContent] : null,
                        rawInput: { serverName: params.serverName, schema: params.requestedSchema },
                    },
                    ...(isToolApproval ? { _meta: { is_mcp_tool_approval: true } } : {}),
                    options,
                },
                correlatedCallId: undefined,
            };
        }

        return {
            request: {
                sessionId: this.sessionState.sessionId,
                toolCall: {
                    toolCallId: `elicitation-${params.elicitationId}`,
                    kind: "fetch",
                    status: "pending",
                    content: messageContent ? [messageContent] : null,
                    rawInput: { serverName: params.serverName, url: params.url },
                },
                options,
            },
            correlatedCallId: undefined,
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
        }
        if (optionId === "allow_always") {
            return { decision: "acceptForSession" };
        }
        return { decision: "decline" };
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
        }
        if (optionId === "allow_always") {
            return { decision: "acceptForSession" };
        }
        return { decision: "cancel" };
    }

    private convertElicitationResponse(
        response: acp.RequestPermissionResponse
    ): McpServerElicitationRequestResponse {
        if (response.outcome.outcome === "cancelled") {
            return { action: "cancel", content: null, _meta: null };
        }

        switch (response.outcome.optionId) {
            case OPTION_ALLOW_SESSION:
                return { action: "accept", content: null, _meta: { persist: "session" } };
            case OPTION_ALLOW_ALWAYS:
                return { action: "accept", content: null, _meta: { persist: "always" } };
            case OPTION_ALLOW_ONCE:
            case "accept":
                return { action: "accept", content: null, _meta: null };
            default:
                return { action: "decline", content: null, _meta: null };
        }
    }

    private createMcpToolProgressEvent(event: { itemId: string, message: string }): UpdateSessionEvent {
        const logDelta = event.message.trim();
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: event.itemId,
            _meta: {
                mcp_output_delta: {
                    data: logDelta,
                }
            }
        };
    }

    private trackItemStarted(event: ItemStartedNotification): void {
        if (event.item.type === "mcpToolCall") {
            this.pendingMcpApprovals.set(this.pendingApprovalKey(event.threadId, event.item.server), event.item.id);
        }
    }

    private trackItemCompleted(event: ItemCompletedNotification): void {
        if (event.item.type === "mcpToolCall") {
            // This may run after the elicitation path already consumed the same entry.
            // That double-pop is intentional: approvals pop on request correlation, while
            // auto-approved or interrupted calls need completion-side cleanup.
            this.popPendingApproval(event.threadId, event.item.server);
        }
    }

    private popPendingApproval(threadId: string, serverName: string): string | undefined {
        const key = this.pendingApprovalKey(threadId, serverName);
        const callId = this.pendingMcpApprovals.get(key);
        this.pendingMcpApprovals.delete(key);
        return callId;
    }

    private clearThreadApprovals(threadId: string): void {
        for (const key of this.pendingMcpApprovals.keys()) {
            if (key.startsWith(`${threadId}:`)) {
                this.pendingMcpApprovals.delete(key);
            }
        }
    }

    private pendingApprovalKey(threadId: string, serverName: string): string {
        return `${threadId}:${serverName}`;
    }

    static createMcpStartupUpdates(event: McpStartupCompleteEvent): UpdateSessionEvent[] {
        const failedUpdates = event.failed.map((server: McpStartupCompleteEvent["failed"][number]) => this.createMcpStartupToolCallUpdate(
            server.server,
            `[codex-acp forwarded startup error] MCP server \`${server.server}\` failed to start: ${server.error}`
        ));
        const cancelledUpdates = event.cancelled.map((server: McpStartupCompleteEvent["cancelled"][number]) => this.createMcpStartupToolCallUpdate(
            server,
            `[codex-acp forwarded startup error] MCP server \`${server}\` startup was cancelled.`
        ));

        return [...failedUpdates, ...cancelledUpdates];
    }

    private static createMcpStartupToolCallUpdate(serverName: string, message: string): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: this.getMcpStartupToolCallId(serverName),
            kind: "other",
            title: `mcp__${serverName}__startup`,
            status: "failed",
            content: [{
                type: "content",
                content: {
                    type: "text",
                    text: message,
                },
            }],
        };
    }

    private static getMcpStartupToolCallId(serverName: string): string {
        return `mcp_startup.${encodeURIComponent(serverName)}`;
    }

    private completeCommandExecutionEvent(item: ThreadItem & { type: "commandExecution" }): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: item.id,
            status: item.status === "completed" ? "completed" : "failed",
            rawOutput: {
                formatted_output: item.aggregatedOutput ?? "",
                exit_code: item.exitCode
            },
            _meta: {
                terminal_exit: {
                    exit_code: item.exitCode,
                    signal: null,
                    terminal_id: item.id
                }
            }
        };
    }

    private async updatePlan(event: TurnPlanUpdatedNotification): Promise<UpdateSessionEvent> {
        const plan: PlanEntry[] = event.plan.map(value => ({
            status: value.status == "inProgress" ? "in_progress" : value.status,
            content: value.step,
            priority: "medium"
        }));
        return {
            sessionUpdate: "plan",
            entries: plan,
        };
    }

    private async createErrorEvent(params: ErrorNotification): Promise<UpdateSessionEvent> {
        const error = params.error.codexErrorInfo;
        if (error == "unauthorized" || error == "usageLimitExceeded" || this.getHttpStatusCode(error) == 401) {
            this.failure = RequestError.authRequired();
        }
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `${params.error.message}\n\n`
            }
        };
    }

    private getHttpStatusCode(error: CodexErrorInfo | null): number | null {
        if (error !== null && typeof error === "object") {
            if ("httpConnectionFailed" in error) {
                return error.httpConnectionFailed.httpStatusCode;
            }
            if ("responseStreamConnectionFailed" in error) {
                return error.responseStreamConnectionFailed.httpStatusCode;
            }
            if ("responseStreamDisconnected" in error) {
                return error.responseStreamDisconnected.httpStatusCode;
            }
            if ("responseTooManyFailedAttempts" in error) {
                return error.responseTooManyFailedAttempts.httpStatusCode;
            }
        }
        return null;
    }

    private handleTokenUsageUpdated(params: ThreadTokenUsageUpdatedNotification): void {
        this.sessionState.lastTokenUsage = toTokenCount(params.tokenUsage.last);
        this.sessionState.totalTokenUsage = toTokenCount(params.tokenUsage.total);
        this.sessionState.modelContextWindow = params.tokenUsage.modelContextWindow;
    }

    private createUsageUpdate(params: ThreadTokenUsageUpdatedNotification): UpdateSessionEvent | null {
        this.handleTokenUsageUpdated(params);

        const used = this.sessionState.lastTokenUsage?.totalTokens;
        const size = this.sessionState.modelContextWindow;
        if (used == null || size == null || size <= 0) {
            return null;
        }

        return {
            sessionUpdate: "usage_update",
            used,
            size,
        };
    }

    private handleRateLimitsUpdated(params: AccountRateLimitsUpdatedNotification): void {
        if (!this.sessionState.rateLimits) {
            this.sessionState.rateLimits = new Map();
        }
        const limitId = params.rateLimits.limitId ?? params.rateLimits.limitName ?? "unknown";
        this.sessionState.rateLimits.set(limitId, {
            limitId: limitId,
            limitName: params.rateLimits.limitName ?? limitId,
            snapshot: params.rateLimits,
        });
    }

    private handleFuzzyFileSearchSessionUpdated(
        params: FuzzyFileSearchSessionUpdatedNotification
    ): UpdateSessionEvent {
        const toolCallId = fuzzyFileSearchToolCallId(params.sessionId);
        const started = !this.activeFuzzyFileSearchSessions.has(toolCallId);
        this.activeFuzzyFileSearchSessions.add(toolCallId);
        return createFuzzyFileSearchStartOrUpdate(params, started);
    }

    private handleFuzzyFileSearchSessionCompleted(
        params: FuzzyFileSearchSessionCompletedNotification
    ): UpdateSessionEvent {
        const toolCallId = fuzzyFileSearchToolCallId(params.sessionId);
        this.activeFuzzyFileSearchSessions.delete(toolCallId);
        return createFuzzyFileSearchComplete(params);
    }
}
