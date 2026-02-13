export type ExtMethodRequest = AuthenticationStatusRequest | AuthenticationLogoutRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status" || request.method === "authentication/logout";
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}