import type {ThreadItem} from "../../app-server/v2";
import type {PermissionToolFacts, ToolFacts} from "../ToolFacts";
import {toTerminalToolStatus, toToolStatus} from "./ToolStatus";

export type McpToolCallItem = ThreadItem & {type: "mcpToolCall"};

/**
 * Reports a Codex MCP tool call.
 * Every client gets the whole Codex result and error in `rawOutput = {result, error}`, and no `content`.
 * AIR shows the text of `rawOutput.result` and `rawOutput.error.message`.
 */
export class McpToolReporter {
    static started(item: McpToolCallItem): ToolFacts {
        return {
            ...mcpIdentity(item),
            report: "start",
            kind: "execute",
            title: `mcp.${item.server}.${item.tool}`,
            status: toToolStatus(item.status),
            ...resultFacts(item),
        };
    }

    static permission(item: McpToolCallItem): PermissionToolFacts {
        return {...mcpIdentity(item), kind: "execute", status: "pending"};
    }

    static completed(item: McpToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            status: toTerminalToolStatus(item.status),
            input: mcpInput(item),
            ...resultFacts(item),
        };
    }

    /** MCP progress text, trimmed, for a client that is not AIR. The event handler sends no progress to AIR. */
    static progress(itemId: string, message: string): ToolFacts {
        return {toolCallId: itemId, report: "update", standard: {mcpProgress: message.trim()}};
    }
}

function mcpIdentity(item: McpToolCallItem): Pick<ToolFacts, "toolCallId" | "name" | "input" | "mcp"> {
    return {toolCallId: item.id, name: "mcp_tool_call", input: mcpInput(item), mcp: true};
}

function mcpInput(item: McpToolCallItem): Record<string, unknown> {
    return {server: item.server, tool: item.tool, arguments: item.arguments};
}

function resultFacts(item: McpToolCallItem): Pick<ToolFacts, "opaqueResult"> {
    return item.result === null && item.error === null ? {} : {opaqueResult: {result: item.result, error: item.error}};
}
