import type {McpHttpRequestAttribution} from "@agentclientprotocol/sdk/experimental/mcp-http";
import {isRecord} from "../permissions/json";

/** How long a request waits for the report of its tool call. After that it is forwarded without the tool call. */
const TOOL_CALL_REPORT_WAIT_MS = 500;

/** What the adapter knows about the ACP sessions of one connection. */
export type McpAttributionSessions = {
    /** Whether the ID is a root session of this connection that is not closing or closed. */
    isOpenRootSession(sessionId: string): boolean;
    /** The ACP session that reports the items of a subagent thread, or `null` when subagents get no session. */
    subagentSessionId(rootSessionId: string, threadId: string): string | null;
    /** Resolves `true` once the client has a report of the tool call on that session, `false` when `signal` aborts first. */
    toolCallSent(sessionId: string, toolCallId: string, signal: AbortSignal): Promise<boolean>;
};

/**
 * Names the ACP session and tool call of an MCP request that Codex sent to a bridged server.
 *
 * An MCP request does not carry them. Codex puts its own IDs in `params._meta` of each `tools/call`: `sessionId` is the
 * root thread, `threadId` the thread that made the call, and `callId` the `mcpToolCall` item. Other requests, such as
 * `tools/list`, have none of them and get no attribution.
 */
export async function attributeMcpRequest(
    params: Record<string, unknown> | undefined,
    sessions: McpAttributionSessions,
    signal: AbortSignal,
    waitMs = TOOL_CALL_REPORT_WAIT_MS,
): Promise<McpHttpRequestAttribution | undefined> {
    const meta = params?.["_meta"];
    if (!isRecord(meta) || typeof meta["threadId"] !== "string") return undefined;
    const threadId = meta["threadId"];
    // A call made through the app-server API names only its thread.
    const rootSessionId = typeof meta["sessionId"] === "string" ? meta["sessionId"] : threadId;
    if (!sessions.isOpenRootSession(rootSessionId)) return undefined;

    const sessionId = threadId === rootSessionId ? rootSessionId : sessions.subagentSessionId(rootSessionId, threadId);
    // The client then sees the subagent's work as part of the root session, and gets no report of its tool calls.
    if (sessionId === null) return {sessionId: rootSessionId};

    const callId = meta["callId"];
    // Codex starts the `mcpToolCall` item before it sends the request, but the two reach the adapter on different
    // channels, so the request can arrive first.
    const reported = typeof callId === "string"
        && await sessions.toolCallSent(sessionId, callId, AbortSignal.any([signal, AbortSignal.timeout(waitMs)]));
    if (!sessions.isOpenRootSession(rootSessionId)) return undefined;
    if (reported) return {sessionId, toolCallId: callId};
    // Only a report on a child session shows that the client knows the child. The root is not named in its place.
    return sessionId === rootSessionId ? {sessionId} : undefined;
}
