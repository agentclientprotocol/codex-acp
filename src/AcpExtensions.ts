import type {
    ClientContext,
    ContentBlock,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";
import {
    GOAL_CONTROL_METHOD,
    LEGACY_GOAL_CONTROL_METHOD,
    type GoalControlRequest,
} from "./GoalExtension";

export {
    GOAL_CONTROL_ACTIONS,
    GOAL_CONTROL_METHOD,
    GOAL_EXTENSION_VERSION,
    LEGACY_GOAL_CONTROL_METHOD,
    type GoalCapability,
    type GoalControlAction,
    type GoalControlRequest,
    type GoalSnapshot,
    type GoalStatus,
} from "./GoalExtension";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const SESSION_STEERING_METHOD = "_session/steering";
export const KANDEV_GUARDED_TTY_CAPABILITY = "kandev.guarded-tty-exec";
export const KANDEV_GUARDED_TTY_VERSION = 1;
export const KANDEV_GUARDED_TTY_CAPABILITY_METHOD = "_kandev/guarded_tty/capability";
export const KANDEV_GUARDED_TTY_EXEC_METHOD = "_kandev/guarded_tty/exec";

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
    | SessionSteeringExtRequest
    | GoalControlExtRequest
    | KandevGuardedTtyCapabilityExtRequest
    | KandevGuardedTtyExecExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === GOAL_CONTROL_METHOD
        || request.method === LEGACY_GOAL_CONTROL_METHOD
        || request.method === SESSION_STEERING_METHOD
        || request.method === KANDEV_GUARDED_TTY_CAPABILITY_METHOD
        || request.method === KANDEV_GUARDED_TTY_EXEC_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type GoalControlExtRequest = {
    method: typeof GOAL_CONTROL_METHOD | typeof LEGACY_GOAL_CONTROL_METHOD;
    params: GoalControlRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}

export type SessionSteerRequest = {
    sessionId: SessionId;
    prompt: ContentBlock[];
}

export type SessionSteeringResponse = {
    outcome: "injected" | "startedNewTurn" | "failed";
}

export type SessionSteeringExtRequest = {
    method: typeof SESSION_STEERING_METHOD;
    params: SessionSteerRequest;
}

export type KandevGuardedTtyCapabilityRequest = {
    sessionId: SessionId;
}

export type KandevGuardedTtyCapabilityResponse = {
    capability: typeof KANDEV_GUARDED_TTY_CAPABILITY;
    version: typeof KANDEV_GUARDED_TTY_VERSION;
    supported: true;
    capability_method: typeof KANDEV_GUARDED_TTY_CAPABILITY_METHOD;
    exec_method: typeof KANDEV_GUARDED_TTY_EXEC_METHOD;
    session_id: SessionId;
}

export type KandevGuardedTtyCapabilityExtRequest = {
    method: typeof KANDEV_GUARDED_TTY_CAPABILITY_METHOD;
    params: KandevGuardedTtyCapabilityRequest;
}

export type KandevGuardedTtyExecRequest = {
    sessionId: SessionId;
    argv: string[];
}

export type KandevGuardedTtyDenialCode =
    | "app_server_error"
    | "cancelled"
    | "invalid_output"
    | "output_overflow"
    | "stale_session"
    | "timeout";

export type KandevGuardedTtyExecReceipt = {
    capability: typeof KANDEV_GUARDED_TTY_CAPABILITY;
    version: typeof KANDEV_GUARDED_TTY_VERSION;
    session_id: SessionId;
    method: "command/exec";
    requested_tty: true;
    dispatched_tty: boolean;
    process_id: string | null;
    cwd: string | null;
    outcome: "completed" | "failed" | "denied";
    denial_code: KandevGuardedTtyDenialCode | null;
    stdout: string;
    stderr: string;
    stdout_bytes: number;
    stderr_bytes: number;
    output_bytes: number;
    exit_code: number | null;
    started_at: string;
    completed_at: string;
}

export type KandevGuardedTtyExecExtRequest = {
    method: typeof KANDEV_GUARDED_TTY_EXEC_METHOD;
    params: KandevGuardedTtyExecRequest;
}

export async function steerSessionWithFallback(
    connection: Pick<ClientContext, "request">,
    params: SessionSteerRequest,
): Promise<SessionSteeringResponse> {
    return await connection.request<SessionSteeringResponse, SessionSteerRequest>(SESSION_STEERING_METHOD, params);
}
