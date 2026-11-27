import type {ThreadItem} from "../../app-server/v2";
import type {ToolFacts} from "../ToolFacts";
import {toTerminalToolStatus, toToolStatus} from "./ToolStatus";
import {mcpAppToolCallMeta} from "../../McpApps";

type McpToolCallItem = ThreadItem & {type: "mcpToolCall"};

/**
 * Reports a Codex MCP tool call.
 * Every client gets the whole Codex result and error in `rawOutput = {result, error}`, and no `content`.
 * AIR shows the text of `rawOutput.result` and `rawOutput.error.message`.
 * A finished call of a tool with a `ui://` resource also has `mcpApp` (see `docs/mcp-apps.md`): a replayed one in its start report.
 */
export class McpToolReporter {
    static started(item: McpToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            kind: "execute",
            title: `mcp.${item.server}.${item.tool}`,
            status: toToolStatus(item.status),
            input: mcpInput(item),
            ...resultFacts(item),
            ...mcpAppFacts(item),
            mcp: true,
        };
    }

    static completed(item: McpToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            status: toTerminalToolStatus(item.status),
            input: mcpInput(item),
            ...resultFacts(item),
            ...mcpAppFacts(item),
        };
    }

    /** MCP progress text, trimmed, for a client that is not AIR. The event handler sends no progress to AIR. */
    static progress(itemId: string, message: string): ToolFacts {
        return {toolCallId: itemId, report: "update", standard: {mcpProgress: message.trim()}};
    }
}

function mcpInput(item: McpToolCallItem): Record<string, unknown> {
    return {server: item.server, tool: item.tool, arguments: item.arguments};
}

function resultFacts(item: McpToolCallItem): Pick<ToolFacts, "opaqueResult"> {
    return item.result === null && item.error === null ? {} : {opaqueResult: {result: item.result, error: item.error}};
}

function mcpAppFacts(item: McpToolCallItem): Pick<ToolFacts, "mcpApp"> {
    const mcpApp = mcpAppToolCallMeta(item);
    return mcpApp === undefined ? {} : {mcpApp};
}
