import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type {JsonObject} from "./CodexAcpClient";

/**
 * An MCP server entry from an ACP v1 or v2 session request.
 */
export type AcpMcpServer = acp.McpServer | acpV2.McpServer;

/**
 * Version-independent MCP server config. Optional v2 fields are already defaulted.
 */
export type NormalizedMcpServer =
    | {
        type: "stdio";
        name: string;
        command: string;
        args: string[];
        env: Array<{name: string; value: string}>;
    }
    | {
        type: "http";
        name: string;
        url: string;
        headers: Array<{name: string; value: string}>;
    };

/**
 * Returns the server name. v2 custom transports have no typed `name`, so it may be empty.
 */
export function getMcpServerName(server: AcpMcpServer): string {
    return typeof server.name === "string" ? server.name : "";
}

/**
 * Converts a v1 or v2 MCP server entry into one shape, rejecting transports Codex can't run.
 */
export function normalizeMcpServer(server: AcpMcpServer): NormalizedMcpServer {
    if (!("type" in server)) {
        // v1 stdio entries have no `type` tag.
        return {type: "stdio", name: server.name, command: server.command, args: server.args, env: server.env};
    }
    switch (server.type) {
        case "stdio": {
            const stdio = server as acpV2.McpServerStdio;
            return {
                type: "stdio",
                name: stdio.name,
                command: stdio.command,
                args: stdio.args ?? [],
                env: stdio.env ?? [],
            };
        }
        case "http": {
            const http = server as acp.McpServerHttp | acpV2.McpServerHttp;
            return {type: "http", name: http.name, url: http.url, headers: http.headers ?? []};
        }
        case "acp":
            throw RequestError.invalidRequest("Codex doesn't support MCP ACP transport protocol");
        case "sse":
            throw RequestError.invalidRequest("Codex doesn't support MCP SSE transport protocol");
        default:
            // v2 allows custom and future transport types.
            throw RequestError.invalidRequest(`Codex doesn't support MCP '${server.type}' transport protocol`);
    }
}

/**
 * Creates a Codex `mcp_servers` config entry.
 */
export function toCodexMcpServerConfig(server: NormalizedMcpServer): JsonObject {
    switch (server.type) {
        case "stdio":
            return {
                "command": server.command,
                "args": server.args,
                "env": Object.fromEntries(server.env.map(env => [env.name, env.value])),
            };
        case "http":
            return {
                "url": server.url,
                "http_headers": Object.fromEntries(server.headers.map(h => [h.name, h.value])),
            };
    }
}

/**
 * A session request whose `mcpServers` may come from either ACP version.
 */
export type WithAcpMcpServers<T extends {mcpServers?: unknown}> = Omit<T, "mcpServers"> & {
    mcpServers?: Array<AcpMcpServer>;
};
