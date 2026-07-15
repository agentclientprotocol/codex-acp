import type {
    ClientContext,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {
    DynamicToolCallParams,
    DynamicToolCallResponse,
    DynamicToolFunctionSpec,
    DynamicToolSpec,
} from "./app-server/v2";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const CODEX_DYNAMIC_TOOLS_META_KEY = "codex/dynamic_tools";
export const CODEX_DYNAMIC_TOOL_CALL_METHOD = "_codex/dynamic_tool_call";

export type LegacySessionModel = {
    modelId: string;
    name: string;
    description?: string | null;
}

export type LegacySessionModelState = {
    availableModels: Array<LegacySessionModel>;
    currentModelId: string;
}

export type LegacySetSessionModelRequest = {
    sessionId: SessionId;
    modelId: string;
}

export type LegacySetSessionModelResponse = {}

export type LegacyNewSessionResponse = NewSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type LegacyLoadSessionResponse = LoadSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type LegacyResumeSessionResponse = ResumeSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type ExtMethodRequest =
    AuthenticationStatusRequest
    | AuthenticationLogoutRequest
    | LegacySetSessionModelExtRequest

export type CodexDynamicToolsMeta = {
    version: 1;
    tools: Array<DynamicToolSpec>;
}

export type CodexDynamicToolCallRequest = {
    method: typeof CODEX_DYNAMIC_TOOL_CALL_METHOD;
    params: DynamicToolCallParams;
}

export type CodexDynamicToolCallResponse = DynamicToolCallResponse;

export function readCodexDynamicToolsMeta(meta?: Record<string, unknown> | null): Array<DynamicToolSpec> | undefined {
    const raw = meta?.[CODEX_DYNAMIC_TOOLS_META_KEY];
    if (raw === undefined) {
        return undefined;
    }
    if (
        !isRecord(raw)
        || raw["version"] !== 1
        || !Array.isArray(raw["tools"])
        || !raw["tools"].every(isDynamicToolSpec)
    ) {
        throw RequestError.invalidParams(undefined, `${CODEX_DYNAMIC_TOOLS_META_KEY} must be a version 1 dynamic tool registry`);
    }
    return raw["tools"];
}

export async function callCodexDynamicTool(
    connection: Pick<ClientContext, "request">,
    params: DynamicToolCallParams,
): Promise<CodexDynamicToolCallResponse> {
    return await connection.request<CodexDynamicToolCallResponse, DynamicToolCallParams>(
        CODEX_DYNAMIC_TOOL_CALL_METHOD,
        params,
    );
}

function isDynamicToolSpec(value: unknown): value is DynamicToolSpec {
    if (!isRecord(value)) {
        return false;
    }
    if (value["type"] === "function") {
        return isDynamicToolFunctionSpec(value);
    }
    return value["type"] === "namespace"
        && isNonEmptyString(value["name"])
        && typeof value["description"] === "string"
        && Array.isArray(value["tools"])
        && value["tools"].every((tool) =>
            isRecord(tool) && tool["type"] === "function" && isDynamicToolFunctionSpec(tool)
        );
}

function isDynamicToolFunctionSpec(value: Record<string, unknown>): value is DynamicToolFunctionSpec & Record<string, unknown> {
    return isNonEmptyString(value["name"])
        && typeof value["description"] === "string"
        && value["inputSchema"] !== undefined
        && (value["deferLoading"] === undefined || typeof value["deferLoading"] === "boolean");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}
