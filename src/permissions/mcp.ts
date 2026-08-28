import type * as acp from "@agentclientprotocol/sdk";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import type {
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
} from "../app-server/v2";
import {optionPermissionMeta} from "./metadata";
import {McpApprovalOptionId} from "./option-ids";
import {isRecord} from "./json";

export type PersistValue = "session" | "always";

export type McpElicitationContext = {
    isToolApproval: boolean;
    persistOptions: Set<PersistValue>;
    correlatedCallId: string | undefined;
};

export function parsePersistOptions(meta: unknown): Set<PersistValue> {
    const result = new Set<PersistValue>();
    if (!isRecord(meta)) return result;
    const persist = meta["persist"];
    if (persist === "session") result.add("session");
    else if (persist === "always") result.add("always");
    else if (Array.isArray(persist)) {
        if (persist.includes("session")) result.add("session");
        if (persist.includes("always")) result.add("always");
    }
    return result;
}

export function isMcpToolCallApproval(meta: unknown): boolean {
    return isRecord(meta) && meta["codex_approval_kind"] === "mcp_tool_call";
}

export function buildMcpPermissionOptions(
    isToolApproval: boolean,
    persistOptions: Set<PersistValue>,
): acp.PermissionOption[] {
    const options: acp.PermissionOption[] = [permissionOption(
        isToolApproval ? McpApprovalOptionId.AllowOnce : "accept",
        "Allow",
        "allow_once",
        isToolApproval ? "Run the tool and continue." : "Allow this request and continue.",
    )];
    if (persistOptions.has("session")) {
        options.push(permissionOption(
            McpApprovalOptionId.AllowSession,
            "Allow for this session",
            "allow_always",
            isToolApproval
                ? "Run the tool and remember this choice for this session."
                : "Allow this request and remember this choice for this session.",
        ));
    }
    if (persistOptions.has("always")) {
        options.push(permissionOption(
            McpApprovalOptionId.AllowAlways,
            "Always allow",
            "allow_always",
            isToolApproval
                ? "Run the tool and remember this choice for future tool calls."
                : "Allow this request and remember this choice for future requests.",
        ));
    }
    if (isToolApproval) {
        options.push(permissionOption(
            McpApprovalOptionId.Cancel,
            "Cancel",
            "reject_once",
            "Cancel this tool call",
        ));
    } else {
        options.push(
            permissionOption(
                McpApprovalOptionId.Decline,
                "Deny",
                "reject_once",
                "Decline this request and continue.",
            ),
            permissionOption(McpApprovalOptionId.Cancel, "Cancel", "reject_once", "Cancel this request"),
        );
    }
    return options;
}

export function buildMcpPermissionRequest(
    sessionId: string,
    params: McpServerElicitationRequestParams,
    context: McpElicitationContext,
    nextStandaloneToolCallId: () => string,
): {request: acp.RequestPermissionRequest; correlatedCallId: string | undefined} {
    const messageContent: acp.ToolCallContent = {
        type: "content",
        content: {type: "text", text: params.message},
    };
    const options = buildMcpPermissionOptions(context.isToolApproval, context.persistOptions);
    if (params.mode === "form" || params.mode === "openai/form") {
        if (context.correlatedCallId !== undefined) {
            return {
                request: {
                    sessionId,
                    toolCall: {
                        toolCallId: context.correlatedCallId,
                        kind: "execute",
                        status: "pending",
                    },
                    _meta: {is_mcp_tool_approval: true},
                    options,
                },
                correlatedCallId: context.correlatedCallId,
            };
        }
        return {
            request: {
                sessionId,
                toolCall: {
                    toolCallId: nextStandaloneToolCallId(),
                    kind: context.isToolApproval ? "execute" : "other",
                    status: "pending",
                    content: [messageContent],
                    rawInput: {serverName: params.serverName, schema: params.requestedSchema},
                },
                ...(context.isToolApproval ? {_meta: {is_mcp_tool_approval: true}} : {}),
                options,
            },
            correlatedCallId: undefined,
        };
    }
    return {
        request: {
            sessionId,
            toolCall: {
                toolCallId: `elicitation-${params.elicitationId}`,
                kind: "fetch",
                status: "pending",
                content: [messageContent],
                rawInput: {serverName: params.serverName, url: params.url},
            },
            options,
        },
        correlatedCallId: undefined,
    };
}

export function convertMcpPermissionResponse(
    response: acp.RequestPermissionResponse,
    isToolApproval: boolean,
    persistOptions: ReadonlySet<PersistValue>,
): McpServerElicitationRequestResponse {
    if (response.outcome.outcome === "cancelled") return cancelledResponse();
    switch (response.outcome.optionId) {
        case McpApprovalOptionId.AllowSession:
            return persistOptions.has("session")
                ? {action: "accept", content: null, _meta: {persist: "session"}}
                : cancelledResponse();
        case McpApprovalOptionId.AllowAlways:
            return persistOptions.has("always")
                ? {action: "accept", content: null, _meta: {persist: "always"}}
                : cancelledResponse();
        case McpApprovalOptionId.AllowOnce:
            return isToolApproval
                ? {action: "accept", content: null, _meta: null}
                : cancelledResponse();
        case "accept":
            return !isToolApproval
                ? {action: "accept", content: null, _meta: null}
                : cancelledResponse();
        case McpApprovalOptionId.Decline:
            return !isToolApproval
                ? {action: "decline", content: null, _meta: null}
                : cancelledResponse();
        case McpApprovalOptionId.Cancel:
        default:
            return cancelledResponse();
    }
}

function permissionOption(
    optionId: string,
    name: string,
    kind: acp.PermissionOptionKind,
    description: string,
): acp.PermissionOption {
    const meta = optionPermissionMeta(description);
    return {optionId, name, kind, ...(meta ? {_meta: meta} : {})};
}

function cancelledResponse(): McpServerElicitationRequestResponse {
    return {action: "cancel", content: null, _meta: null as JsonValue | null};
}
