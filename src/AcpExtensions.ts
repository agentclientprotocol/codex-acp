import type {
    ClientContext,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const GOAL_CONTROL_METHOD = "_codex/session/goal_control";

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
    | GoalControlExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === GOAL_CONTROL_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type GoalControlRequest = {
    sessionId: SessionId;
    action: "pause" | "clear";
}

export type GoalControlExtRequest = {
    method: typeof GOAL_CONTROL_METHOD;
    params: GoalControlRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}
