import {randomUUID} from "node:crypto";
import type {McpStartupCompleteEvent} from "../../app-server/McpStartupCompleteEvent";
import {textContent} from "../AcpToolCallRenderer";
import type {ToolFacts} from "../ToolFacts";

/** Reports the MCP servers that failed to start or were not started. Each report is a new, failed tool call. */
export class McpStartupReporter {
    static skipped(serverNames: string[]): ToolFacts[] {
        return serverNames.map(server => failure(
            server,
            `[codex-acp] MCP server \`${server}\` was not started, because the Codex config already defines an MCP server with this name. Codex uses its own entry, or no server if that entry is disabled.`,
        ));
    }

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
