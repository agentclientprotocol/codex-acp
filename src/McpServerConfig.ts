import type * as acp from "@agentclientprotocol/sdk/unstable";
import {isMcpServerAcp, RequestError} from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {McpServerHttpDeclaration} from "@agentclientprotocol/sdk/experimental/mcp-http";
import type {JsonObject} from "./CodexAcpClient";
import {sanitizeMcpServerName} from "./McpServerName";
import {isAbsoluteProtocolPath} from "./PathUtils";
import type {McpStartupFailure} from "./mcp/McpStartupTracker";

/**
 * An MCP server entry from an ACP v1 or v2 session request.
 */
export type AcpMcpServer = acp.McpServer | acpV2.McpServer;

/** Re-exports one registration as HTTP for Codex, on the ACP connection that declared it. */
export type McpOverAcpToHttp = (server: acp.McpServerAcpDeclaration) => Promise<McpServerHttpDeclaration>;

/**
 * Version-independent MCP server config. Optional v2 fields are already defaulted.
 */
export type NormalizedMcpServer =
    | {type: "acp"; name: string; toHttp(): Promise<McpServerHttpDeclaration>}
    | McpServerHttpDeclaration
    | {
        type: "stdio";
        name: string;
        command: string;
        args: string[];
        env: Array<{name: string; value: string}>;
    };

/**
 * Returns the server name. v2 custom transports have no typed `name`, so it may be empty.
 */
export function getMcpServerName(server: AcpMcpServer): string {
    return typeof server.name === "string" ? server.name : "";
}

/** Validate the whole request before filtering out servers configured independently of ACP. */
export function normalizeMcpServers(servers: AcpMcpServer[], toHttp?: McpOverAcpToHttp): NormalizedMcpServer[] {
    const names = new Set<string>();
    return servers.map(server => {
        const name = sanitizeMcpServerName(getMcpServerName(server));
        // Codex keys servers by the sanitized name, so collisions must not silently overwrite one.
        if (names.has(name)) throw RequestError.invalidParams({name: getMcpServerName(server)}, "MCP server names must be unique");
        names.add(name);
        return {...normalizeMcpServer(server, toHttp), name};
    });
}

/**
 * Converts a v1 or v2 MCP server entry into one shape, rejecting transports Codex can't run.
 */
export function normalizeMcpServer(server: AcpMcpServer, toHttp?: McpOverAcpToHttp): NormalizedMcpServer {
    if (!("type" in server)) {
        // v1 stdio entries have no `type` tag.
        return {type: "stdio", name: server.name, command: server.command, args: server.args, env: server.env};
    }
    switch (server.type) {
        case "stdio": {
            const stdio = server as acpV2.McpServerStdio;
            // Codex needs a NUL-free, fully qualified path. The SDK also accepts `\bin\server`.
            if (!isAbsoluteProtocolPath(stdio.command)) {
                throw RequestError.invalidParams({name: stdio.name, command: stdio.command},
                    "A stdio MCP server command must be a fully qualified executable path without NUL");
            }
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
        case "acp": {
            if (!isMcpServerAcp(server)) {
                throw RequestError.invalidParams(undefined, "An ACP MCP server requires a string name and serverId");
            }
            if (!toHttp) throw RequestError.invalidParams(undefined, "MCP-over-ACP is unavailable on this connection");
            // Validate now, but open a listener only if this server survives name filtering.
            return {type: "acp", name: server.name, toHttp: () => toHttp(server)};
        }
        case "sse":
            throw RequestError.invalidParams(undefined, "Codex doesn't support MCP SSE transport protocol");
        default:
            // v2 allows custom and future transport types.
            throw RequestError.invalidParams(undefined, `Codex doesn't support MCP '${server.type}' transport protocol`);
    }
}

/** Declarations have already been validated. A listener failure affects only this server. */
export async function prepareMcpServer(server: NormalizedMcpServer): Promise<
    {name: string; config: JsonObject; bridged: boolean} | {failure: McpStartupFailure}
> {
    const {name} = server;
    const bridged = server.type === "acp";
    if (server.type === "acp") {
        try {
            server = await server.toHttp();
        } catch {
            return {failure: {server: name, error: "Could not open the MCP-over-ACP endpoint"}};
        }
    }
    switch (server.type) {
        case "stdio":
            return {name, bridged, config: {
                "command": server.command,
                "args": server.args,
                "env": Object.fromEntries(server.env.map(env => [env.name, env.value])),
            }};
        case "http":
            return {name, bridged, config: {
                "url": server.url,
                "http_headers": Object.fromEntries(server.headers.map(h => [h.name, h.value])),
            }};
    }
}

/**
 * A session request whose `mcpServers` may come from either ACP version.
 */
export type WithAcpMcpServers<T extends {mcpServers?: unknown}> = Omit<T, "mcpServers"> & {
    mcpServers?: Array<AcpMcpServer>;
};
