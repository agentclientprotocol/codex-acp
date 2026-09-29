import {randomUUID} from "node:crypto";
import type {McpStartupCompleteEvent} from "../../app-server/McpStartupCompleteEvent";
import {textContent} from "../AcpToolCallRenderer";
import type {ToolFacts} from "../ToolFacts";

/** Reports the MCP servers that failed to start. Each report is a new, failed tool call. */
export class McpStartupReporter {
    static failures(event: McpStartupCompleteEvent): ToolFacts[] {
        return [
            ...event.failed.map(server => failure(
                server.server,
                `[codex-acp forwarded startup error] MCP server \`${server.server}\` failed to start: ${server.error}`,
            )),
            ...event.cancelled.map(server => failure(
                server,
                `[codex-acp forwarded startup error] MCP server \`${server}\` startup was cancelled.`,
            )),
        ];
    }
}

function failure(serverName: string, message: string): ToolFacts {
    return {
        // A unique id, so that a later report for the same server cannot replace this one.
        toolCallId: `mcp_startup.${encodeURIComponent(serverName)}.${randomUUID()}`,
        report: "start",
        kind: "other",
        title: `mcp__${serverName}__startup`,
        status: "failed",
        result: [textContent(message)],
    };
}
