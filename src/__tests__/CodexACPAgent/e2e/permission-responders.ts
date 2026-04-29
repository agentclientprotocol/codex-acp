import * as acp from "@agentclientprotocol/sdk";
import {ApprovalOptionId} from "../../../ApprovalOptionId";

export type PermissionResponder = (
    params: acp.RequestPermissionRequest,
) => acp.RequestPermissionResponse;

export function createPermissionResponder(
    expectedToolCallKind: acp.ToolKind,
    optionId: ApprovalOptionId,
): PermissionResponder {
    return (request) => createPermissionResponse(
        request.toolCall.kind === expectedToolCallKind ? optionId : null
    );
}

export function createPermissionResponse(optionId: ApprovalOptionId | null): acp.RequestPermissionResponse {
    if (optionId === null) {
        return {outcome: {outcome: "cancelled"}};
    }
    return {outcome: {outcome: "selected", optionId}};
}
