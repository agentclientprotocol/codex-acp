import * as acp from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {isRecord} from "./permissions/json";

/**
 * V2 form string properties follow MCP's string schema, which has no `pattern`.
 * Keep the v1 form intact and omit that keyword only on the v2 wire.
 */
export function toV2CreateElicitationRequest(request: acp.CreateElicitationRequest): acpV2.CreateElicitationRequest {
    const v2 = request as unknown as acpV2.CreateElicitationRequest;
    if (request.mode !== "form" || !isRecord(request.requestedSchema) || !isRecord(request.requestedSchema["properties"])) return v2;
    const properties = Object.fromEntries(Object.entries(request.requestedSchema["properties"]).map(([key, property]) => {
        if (!isRecord(property) || property["type"] !== "string" || !("pattern" in property)) return [key, property];
        const {pattern: _pattern, ...rest} = property;
        return [key, rest];
    }));
    return {...request, requestedSchema: {...request.requestedSchema, properties}} as unknown as acpV2.CreateElicitationRequest;
}

/** V2 responses keep arbitrary JSON values through the v1-typed view. */
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
