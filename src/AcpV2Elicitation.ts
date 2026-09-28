import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";

/**
 * `elicitation/create`'s request/response, and `elicitation/complete`'s notification, are
 * wire-identical between v1 and v2 (same fields, same method names) -- unlike
 * `session/request_permission`, there is no shape to render, only the type import differs per
 * version. These are identity casts kept as named conversion points so the rest of the codebase
 * never has to reach into the v2 namespace directly.
 */
export function toV2CreateElicitationRequest(request: acp.CreateElicitationRequest): acpV2.CreateElicitationRequest {
    return request as unknown as acpV2.CreateElicitationRequest;
}

export function toV1CreateElicitationResponse(response: acpV2.CreateElicitationResponse): acp.CreateElicitationResponse {
    return response as unknown as acp.CreateElicitationResponse;
}

/** A session-scoped elicitation carries `sessionId`; a request-scoped one carries `requestId` instead. */
export function elicitationSessionId(request: acp.CreateElicitationRequest): string | undefined {
    const sessionId = (request as {sessionId?: unknown}).sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
}
