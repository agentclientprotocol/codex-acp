import * as acp from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {AIR_CUSTOM_ANSWER_FIELDS_KEY, isAirCustomAnswer, withAirMeta} from "./AirExtension";

/**
 * Keeps the shared elicitation wire shape and moves Air's companion IDs to v2 request metadata.
 * V2 responses retain arbitrary JSON values for validation by their shared consumers.
 */
export function toV2CreateElicitationRequest(request: acp.CreateElicitationRequest): acpV2.CreateElicitationRequest {
    if (!acp.CreateElicitationRequest.isForm(request)) return request as unknown as acpV2.CreateElicitationRequest;
    const fields = Object.entries(request.requestedSchema.properties ?? {})
        .filter(([, property]) => isAirCustomAnswer(property._meta))
        .map(([id]) => id);
    if (fields.length === 0) return request as unknown as acpV2.CreateElicitationRequest;
    // V2 schema properties have no metadata. Keep the companion IDs on the request.
    return {...request, _meta: withAirMeta(request._meta, AIR_CUSTOM_ANSWER_FIELDS_KEY, fields)} as unknown as acpV2.CreateElicitationRequest;
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
