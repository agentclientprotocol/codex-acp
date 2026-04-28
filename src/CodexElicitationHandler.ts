import * as acp from "@agentclientprotocol/sdk";
import type { SessionState } from "./CodexAcpServer";
import type { ElicitationHandler } from "./CodexAppServerClient";
import type { ServerNotification } from "./app-server";
import type {
    ItemCompletedNotification,
    ItemStartedNotification,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
} from "./app-server/v2";
import { logger } from "./Logger";
import { ApprovalOptionId } from "./ApprovalOptionId";

// Standard elicitation options (non-tool-call approval).
const ELICITATION_OPTIONS: acp.PermissionOption[] = [
    { optionId: "accept", name: "Accept", kind: "allow_once" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
];

// Option ID unique to elicitation persist choices — not part of the shared ApprovalOptionId set.
const OPTION_ALLOW_SESSION = "allow_session";

type PersistValue = "session" | "always";

/**
 * Parses the `persist` field from the elicitation request `_meta`.
 * Codex advertises which persistence options the client should show.
 * Returns a set of supported persist values.
 */
function parsePersistOptions(meta: unknown): Set<PersistValue> {
    const result = new Set<PersistValue>();
    if (!meta || typeof meta !== "object") return result;
    const persist = (meta as Record<string, unknown>)["persist"];
    if (persist === "session") {
        result.add("session");
    } else if (persist === "always") {
        result.add("always");
    } else if (Array.isArray(persist)) {
        if (persist.includes("session")) result.add("session");
        if (persist.includes("always")) result.add("always");
    }
    return result;
}

function isMcpToolCallApproval(meta: unknown): boolean {
    return (
        meta !== null &&
        typeof meta === "object" &&
        (meta as Record<string, unknown>)["codex_approval_kind"] === "mcp_tool_call"
    );
}

/**
 * Builds the ACP permission options for an MCP tool call approval elicitation.
 * Always includes "Allow Once"; adds session/always persist options when advertised.
 */
function buildToolApprovalOptions(persistOptions: Set<PersistValue>): acp.PermissionOption[] {
    const options: acp.PermissionOption[] = [
        { optionId: ApprovalOptionId.AllowOnce, name: "Allow", kind: "allow_once" },
    ];
    if (persistOptions.has("session")) {
        options.push({ optionId: OPTION_ALLOW_SESSION, name: "Allow for This Session", kind: "allow_always" });
    }
    if (persistOptions.has("always")) {
        options.push({ optionId: ApprovalOptionId.AllowAlways, name: "Allow and Don't Ask Again", kind: "allow_always" });
    }
    options.push({ optionId: "decline", name: "Decline", kind: "reject_once" });
    return options;
}

export class CodexElicitationHandler implements ElicitationHandler {
    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
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

    constructor(connection: acp.AgentSideConnection, sessionState: SessionState) {
        this.connection = connection;
        this.sessionState = sessionState;
    }

    handleNotification(notification: ServerNotification): void {
        switch (notification.method) {
            case "item/started":
                this.handleItemStarted(notification.params);
                return;
            case "item/completed":
                this.handleItemCompleted(notification.params);
                return;
            case "serverRequest/resolved":
                this.clearThread(notification.params.threadId);
                return;
            default:
                return;
        }
    }

    async handleElicitation(
        params: McpServerElicitationRequestParams
    ): Promise<McpServerElicitationRequestResponse> {
        try {
            const { request, correlatedCallId } = this.buildPermissionRequest(params);
            const response = await this.connection.requestPermission(request);
            if (correlatedCallId !== undefined && response.outcome.outcome !== "cancelled") {
                const optionId = response.outcome.optionId;
                if (optionId !== "decline") {
                    await this.connection.sessionUpdate({
                        sessionId: this.sessionState.sessionId,
                        update: { sessionUpdate: "tool_call_update", toolCallId: correlatedCallId, status: "in_progress" },
                    });
                }
            }
            return this.convertResponse(response);
        } catch (error) {
            logger.error("Error handling MCP elicitation request", error);
            return { action: "cancel", content: null, _meta: null };
        }
    }

    private buildPermissionRequest(
        params: McpServerElicitationRequestParams
    ): { request: acp.RequestPermissionRequest; correlatedCallId: string | undefined } {
        const sessionId = this.sessionState.sessionId;
        const messageContent: acp.ToolCallContent = {
            type: "content",
            content: { type: "text", text: params.message },
        };

        const meta = params._meta;
        const isToolApproval = isMcpToolCallApproval(meta);
        const options = isToolApproval
            ? buildToolApprovalOptions(parsePersistOptions(meta))
            : ELICITATION_OPTIONS;

        if (params.mode === "form") {
            const correlatedCallId = isToolApproval
                ? this.popPendingApproval(params.threadId, params.serverName)
                : undefined;
            if (correlatedCallId !== undefined) {
                // The tool call item is already visible in the IDE conversation history because
                // item/started was emitted before the elicitation request. Sending content or
                // rawInput here would duplicate that information in the approval widget.
                return {
                    request: {
                        sessionId,
                        toolCall: {
                            toolCallId: correlatedCallId,
                            kind: "execute",
                            status: "pending",
                            // content: [messageContent],   — omitted: already rendered via item/started
                            // rawInput: { ... }            — omitted: same reason
                        },
                        _meta: { is_mcp_tool_approval: true },
                        options,
                    },
                    correlatedCallId,
                };
            }
            return {
                request: {
                    sessionId,
                    toolCall: {
                        toolCallId: `elicitation-${params.serverName}`,
                        kind: isToolApproval ? "execute" : "other",
                        status: "pending",
                        content: [messageContent],
                        rawInput: { serverName: params.serverName, schema: params.requestedSchema },
                    },
                    ...(isToolApproval ? { _meta: { is_mcp_tool_approval: true } } : {}),
                    options,
                },
                correlatedCallId: undefined,
            };
        } else {
            return {
                request: {
                    sessionId,
                    toolCall: {
                        toolCallId: `elicitation-${params.elicitationId}`,
                        kind: "fetch",
                        status: "pending",
                        content: [messageContent],
                        rawInput: { serverName: params.serverName, url: params.url },
                    },
                    options,
                },
                correlatedCallId: undefined,
            };
        }
    }

    private convertResponse(
        response: acp.RequestPermissionResponse
    ): McpServerElicitationRequestResponse {
        if (response.outcome.outcome === "cancelled") {
            return { action: "cancel", content: null, _meta: null };
        }

        const optionId = response.outcome.optionId;
        if (optionId === OPTION_ALLOW_SESSION) {
            return { action: "accept", content: null, _meta: { persist: "session" } };
        }
        if (optionId === ApprovalOptionId.AllowAlways) {
            return { action: "accept", content: null, _meta: { persist: "always" } };
        }
        if (optionId === ApprovalOptionId.AllowOnce || optionId === "accept") {
            return { action: "accept", content: null, _meta: null };
        }
        return { action: "decline", content: null, _meta: null };
    }

    private handleItemStarted(event: ItemStartedNotification): void {
        if (event.item.type !== "mcpToolCall") {
            return;
        }
        this.pendingMcpApprovals.set(this.key(event.threadId, event.item.server), event.item.id);
    }

    private handleItemCompleted(event: ItemCompletedNotification): void {
        if (event.item.type !== "mcpToolCall") {
            return;
        }
        // This may run after the elicitation path already consumed the same entry.
        // That double-pop is intentional: approvals pop on request correlation, while
        // auto-approved or interrupted calls need completion-side cleanup.
        this.popPendingApproval(event.threadId, event.item.server);
    }

    private popPendingApproval(threadId: string, serverName: string): string | undefined {
        const key = this.key(threadId, serverName);
        const callId = this.pendingMcpApprovals.get(key);
        this.pendingMcpApprovals.delete(key);
        return callId;
    }

    private clearThread(threadId: string): void {
        for (const key of this.pendingMcpApprovals.keys()) {
            if (this.belongsToThread(key, threadId)) {
                this.pendingMcpApprovals.delete(key);
            }
        }
    }

    private key(threadId: string, serverName: string): string {
        return `${threadId}:${serverName}`;
    }

    private belongsToThread(key: string, threadId: string): boolean {
        return key.startsWith(`${threadId}:`);
    }
}
