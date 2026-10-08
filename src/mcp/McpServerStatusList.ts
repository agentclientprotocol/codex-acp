import type {CodexAcpClient} from "../CodexAcpClient";
import type {McpServerStatus} from "../app-server/v2";
import {logger} from "../Logger";

/**
 * Returns the status of every MCP server. With `threadId`, the status includes the live connection
 * state of that thread. The function reads all pages.
 */
export async function listMcpServerStatus(codexAcpClient: CodexAcpClient, threadId?: string): Promise<Array<McpServerStatus>> {
    const servers: Array<McpServerStatus> = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
        const page = await codexAcpClient.listMcpServers({
            cursor,
            detail: "toolsAndAuthOnly",
            ...(threadId === undefined ? {} : {threadId}),
        });
        servers.push(...page.data);
        cursor = page.nextCursor;
        if (cursor !== null) {
            if (seenCursors.has(cursor)) {
                logger.log(`MCP server status list repeated the cursor ${cursor}`);
                break;
            }
            seenCursors.add(cursor);
        }
    } while (cursor !== null);
    return servers;
}
