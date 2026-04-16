// In Rust, the MCP elicitation handler receives ElicitationRequestEvent directly from the MCP
// protocol layer, where id is set to "mcp_tool_call_approval_<call_id>" — the call ID is extracted
// by stripping that prefix.
//
// In TypeScript, Codex speaks the app-server JSON-RPC protocol (v2), where McpServerElicitationRequestParams
// omits elicitationId for form mode, so the MCP-level ID never reaches the client.
//
// Workaround: before requesting approval, Codex emits an item/started notification with an mcpToolCall
// item carrying the call id and server name. This class stores (threadId, serverName) → callId so the
// elicitation handler can retrieve it when the request arrives.
//
// Multiple calls are safe because Codex requests approval synchronously — it blocks on one tool call's
// elicitation before starting the next, so there is at most one pending approval per (threadId, serverName).
export class PendingMcpApprovals {
    private readonly pending = new Map<string, string>();

    record(threadId: string, serverName: string, callId: string): void {
        this.pending.set(`${threadId}:${serverName}`, callId);
    }

    pop(threadId: string, serverName: string): string | undefined {
        const key = `${threadId}:${serverName}`;
        const callId = this.pending.get(key);
        this.pending.delete(key);
        return callId;
    }
}
