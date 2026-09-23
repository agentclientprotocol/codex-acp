import type {McpServerElicitationRequestParams} from "../../app-server/v2";
import type {PermissionToolFacts, ToolFacts} from "../ToolFacts";

/**
 * Reports an MCP elicitation that the adapter presents as a permission request.
 *
 * A tool approval that belongs to a started MCP tool call reuses that tool call.
 * Any other elicitation is a new tool call. Its message is a question that the user reads.
 */
export class ElicitationReporter {
    static permission(
        params: McpServerElicitationRequestParams,
        isToolApproval: boolean,
        correlatedCallId: string | undefined,
        nextStandaloneToolCallId: () => string,
    ): PermissionToolFacts {
        if (params.mode === "form" || params.mode === "openai/form") {
            if (correlatedCallId !== undefined) {
                // The client already shows the MCP tool call. The request keeps the kind, as before the contract.
                return {toolCallId: correlatedCallId, kind: "execute", status: "pending"};
            }
            return {
                toolCallId: nextStandaloneToolCallId(),
                kind: isToolApproval ? "execute" : "other",
                status: "pending",
                title: isToolApproval ? "MCP tool call approval" : "Question from MCP server",
                input: {serverName: params.serverName, description: params.message, schema: params.requestedSchema},
                readableInput: params.message,
            };
        }
        if (params.mode !== "url") {
            throw new Error(`Unsupported MCP elicitation mode: ${params.mode}`);
        }
        return {
            toolCallId: `elicitation-${params.elicitationId}`,
            kind: "fetch",
            status: "pending",
            title: "MCP server requests to open a URL",
            input: {serverName: params.serverName, description: params.message, url: params.url},
            readableInput: params.message,
        };
    }

    /** The user accepted a tool approval, so the MCP tool call runs. */
    static accepted(correlatedCallId: string): ToolFacts {
        return {toolCallId: correlatedCallId, report: "update", status: "in_progress"};
    }

    /** The user answered a standalone elicitation. */
    static answered(toolCallId: string, action: string): ToolFacts {
        return {toolCallId, report: "update", status: "completed", opaqueResult: {action}};
    }
}
