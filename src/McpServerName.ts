const MCP_SERVER_NAME_WHITESPACE = /\p{White_Space}/gu;

export function sanitizeMcpServerName(name: string): string {
    return name.replace(MCP_SERVER_NAME_WHITESPACE, "_");
}
