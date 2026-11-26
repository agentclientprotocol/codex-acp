import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {z} from "zod";
import type {ThreadItem} from "./app-server/v2";

/**
 * MCP Apps (SEP-1865) for ACP clients: an MCP tool can declare a `ui://` resource
 * (`_meta.ui.resourceUri`) that a host renders next to the tool's result in a sandboxed frame,
 * and the frame can call the server's tools. Codex dials the MCP servers itself, so a client
 * can only reach them through the agent. See `docs/mcp-apps.md`.
 *
 * - on the tool call of an app tool, `_meta.mcpApp`: the server, the tool, the `resourceUri`
 *   and the server's own result;
 * - `_session/mcp/resources/read`: the `ui://` resource, read by Codex (`mcpServer/resource/read`);
 * - `_session/mcp/tools/call`: a tool call for the app, on the session's thread
 *   (`mcpServer/tool/call`), whose result goes to the client and not to the model.
 */

export const MCP_APPS_VERSION = 1 as const;
/** The capability key, in the client's and the agent's `initialize` `_meta`. */
export const MCP_APPS_KEY = "mcpApps";
/** The key of an app tool's `tool_call_update._meta`. */
export const MCP_APP_TOOL_CALL_KEY = "mcpApp";
export const MCP_RESOURCES_READ_METHOD = "_session/mcp/resources/read";
export const MCP_TOOLS_CALL_METHOD = "_session/mcp/tools/call";
/** A `toolResult` longer than this, as JSON, is left out of `_meta.mcpApp`. */
export const MAX_TOOL_RESULT_CHARS = 1_000_000;

export type McpAppsCapability = {
    version: typeof MCP_APPS_VERSION;
    resourcesRead: typeof MCP_RESOURCES_READ_METHOD;
    toolsCall: typeof MCP_TOOLS_CALL_METHOD;
};

export function mcpAppsCapability(): McpAppsCapability {
    return {version: MCP_APPS_VERSION, resourcesRead: MCP_RESOURCES_READ_METHOD, toolsCall: MCP_TOOLS_CALL_METHOD};
}

/** Whether the client declared `clientCapabilities._meta.mcpApps` with a version of at least 1. */
export function clientSupportsMcpApps(capabilities: {_meta?: {[key: string]: unknown} | null} | null | undefined): boolean {
    const declared = capabilities?._meta?.[MCP_APPS_KEY];
    if (!declared || typeof declared !== "object") return false;
    const {version} = declared as {version?: unknown};
    return typeof version === "number" && Number.isInteger(version) && version >= 1;
}

/** An MCP `CallToolResult`, as the server sent it. */
export type McpCallToolResult = {
    content: unknown[];
    structuredContent?: unknown;
    isError?: true;
    _meta?: Record<string, unknown>;
};

/** `tool_call_update._meta.mcpApp` of an app tool's result. */
export type McpAppToolCallMeta = {
    version: typeof MCP_APPS_VERSION;
    /** The server's name, as the client passes it to the two methods. */
    server: string;
    /** The tool's own name on the server. */
    tool: string;
    resourceUri: string;
    /** Absent when the result is longer than {@link MAX_TOOL_RESULT_CHARS}. */
    toolResult?: McpCallToolResult;
};

type McpToolCallItem = ThreadItem & {type: "mcpToolCall"};

/**
 * `_meta.mcpApp` of a finished MCP tool call whose tool declared a `ui://` resource.
 * Codex captures the resource from the tool descriptor (`mcpAppUi`, or the older `mcpAppResourceUri`).
 * Undefined for any other tool call, and for one that has not finished.
 */
export function mcpAppToolCallMeta(item: McpToolCallItem): McpAppToolCallMeta | undefined {
    const resourceUri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri;
    if (typeof resourceUri !== "string" || !resourceUri.startsWith("ui://")) return undefined;
    if (item.status === "inProgress") return undefined;
    const toolResult = item.result ? toCallToolResult(item.result, false) : item.error
        ? {content: [{type: "text", text: item.error.message}], isError: true as const}
        : undefined;
    const fits = toolResult !== undefined && JSON.stringify(toolResult).length <= MAX_TOOL_RESULT_CHARS;
    return {
        version: MCP_APPS_VERSION,
        server: item.server,
        tool: item.tool,
        resourceUri,
        ...(fits ? {toolResult} : {}),
    };
}

/** A `CallToolResult` from Codex's result shape, without its `null` fields. */
export function toCallToolResult(
    result: {content: unknown[]; structuredContent?: unknown; isError?: boolean | null; _meta?: unknown},
    isError: boolean | undefined = result.isError ?? undefined,
): McpCallToolResult {
    return {
        content: result.content,
        ...(result.structuredContent != null ? {structuredContent: result.structuredContent} : {}),
        ...(isError ? {isError: true as const} : {}),
        ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
            ? {_meta: result._meta as Record<string, unknown>} : {}),
    };
}

export const mcpResourcesReadParamsParser = z.object({
    sessionId: z.string().min(1),
    server: z.string().min(1),
    uri: z.string().refine(uri => uri.startsWith("ui://"), "Only ui:// resources can be read"),
    /** The app tool's call, when the resource is read for its result. */
    toolCallId: z.string().min(1).optional(),
}).passthrough();

export const mcpToolsCallParamsParser = z.object({
    sessionId: z.string().min(1),
    server: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
    checkPermissions: z.boolean().optional(),
}).passthrough();

export type McpResourcesReadRequest = z.infer<typeof mcpResourcesReadParamsParser>;
export type McpToolsCallRequest = z.infer<typeof mcpToolsCallParamsParser>;
export type McpResourcesReadResponse = {
    contents: {uri: string; mimeType?: string; text?: string; blob?: string; _meta?: unknown}[];
};

/** Codex runs a client's `mcpServer/tool/call` without an approval, so the adapter cannot decide one for the app. */
export function refuseCheckedCall(request: McpToolsCallRequest): void {
    if (request.checkPermissions) {
        throw RequestError.invalidRequest(
            undefined,
            "Codex cannot check the permissions of an app's tool call. Check the call in the client.",
        );
    }
}
