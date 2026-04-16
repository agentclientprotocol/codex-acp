import * as acp from "@agentclientprotocol/sdk";
import type { SessionState } from "./CodexAcpServer";
import type { ElicitationHandler } from "./CodexAppServerClient";
import type {
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
} from "./app-server/v2";
import { logger } from "./Logger";
import type { PendingMcpApprovals } from "./PendingMcpApprovals";

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

export class CodexElicitationHandler implements ElicitationHandler {
    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;
    private readonly pendingMcpApprovals: PendingMcpApprovals | undefined;

    constructor(
        connection: acp.AgentSideConnection,
        sessionState: SessionState,
        pendingMcpApprovals?: PendingMcpApprovals
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
        this.pendingMcpApprovals = pendingMcpApprovals;
    }

    async handleElicitation(
        params: McpServerElicitationRequestParams
    ): Promise<McpServerElicitationRequestResponse> {
        try {
            const request = this.buildPermissionRequest(params);
            const response = await this.connection.requestPermission(request);
            return this.convertResponse(response);
        } catch (error) {
            logger.error("Error handling MCP elicitation request", error);
            return { action: "cancel", content: null, _meta: null };
        }
    }

    private buildPermissionRequest(
        params: McpServerElicitationRequestParams
    ): acp.RequestPermissionRequest {
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
                ? this.pendingMcpApprovals?.pop(params.threadId, params.serverName)
                : undefined;
            if (correlatedCallId !== undefined) {
                // The tool call item is already visible in the IDE conversation history because
                // item/started was emitted before the elicitation request. Sending content or
                // rawInput here would duplicate that information in the approval widget.
                return {
                    sessionId,
                    toolCall: {
                        toolCallId: correlatedCallId,
                        kind: "execute",
                        status: "pending",
                        // content: [messageContent],   — omitted: already rendered via item/started
                        // rawInput: { ... }            — omitted: same reason
                    },
                    options,
                };
            }
            return {
                sessionId,
                toolCall: {
                    toolCallId: `elicitation-${params.serverName}`,
                    kind: isToolApproval ? "execute" : "other",
                    status: "pending",
                    content: [messageContent],
                    rawInput: { serverName: params.serverName, schema: params.requestedSchema },
                },
                options,
            };
        } else {
            return {
                sessionId,
                toolCall: {
                    toolCallId: `elicitation-${params.elicitationId}`,
                    kind: "fetch",
                    status: "pending",
                    content: [messageContent],
                    rawInput: { serverName: params.serverName, url: params.url },
                },
                options,
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
        if (optionId === OPTION_ALLOW_ALWAYS) {
            return { action: "accept", content: null, _meta: { persist: "always" } };
        }
        if (optionId === OPTION_ALLOW_ONCE || optionId === "accept") {
            return { action: "accept", content: null, _meta: null };
        }
        return { action: "decline", content: null, _meta: null };
    }
}
