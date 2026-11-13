import * as acp from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";

/**
 * `elicitation/create`'s request/response, and `elicitation/complete`'s notification, are
 * share field and method names between v1 and v2 -- unlike
 * `session/request_permission`, there is no shape to render, only the type import differs per
 * version. v2 responses allow arbitrary JSON content values. Keep them intact through the
 * v1-typed view and validate with the v2 response guards in shared consumers.
 */
export function toV2CreateElicitationRequest(request: acp.CreateElicitationRequest): acpV2.CreateElicitationRequest {
    return request as unknown as acpV2.CreateElicitationRequest;
}

export function toV1CreateElicitationResponse(response: acpV2.CreateElicitationResponse): acp.CreateElicitationResponse {
    return response as unknown as acp.CreateElicitationResponse;
}

/** Use the broader response contract when consuming responses through the shared typed view. */
export function toV2CreateElicitationResponse(response: acp.CreateElicitationResponse): acpV2.CreateElicitationResponse {
    return response as unknown as acpV2.CreateElicitationResponse;
}

/** A session-scoped elicitation carries `sessionId`; a request-scoped one carries `requestId` instead. */
export function elicitationSessionId(request: acp.CreateElicitationRequest): string | undefined {
    const sessionId = (request as {sessionId?: unknown}).sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
}
