import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {toV2ToolCallContent} from "./AcpV2SessionUpdate";
import {readPermissionMeta} from "./permissions/metadata";

/**
 * Renders a v1-shaped `session/request_permission` request in the ACP v2 wire shape: v1's bare
 * `toolCall` becomes v2's `{title (required), description?, subject}`.
 *
 * v1 has no dedicated prompt-copy field, so call sites either carry `_meta.permission.title`/
 * `.description` (`requestPermissionMeta`) alongside a genuine `toolCall`, or (plan review) have
 * no such `_meta` and instead set the prompt copy directly as `toolCall.title`. `_meta.permission`
 * wins when present; otherwise `toolCall.title` is promoted to the top-level `title` and dropped
 * from the subject's tool call, since it was the only title available and isn't genuine tool-call
 * state.
 */
export function toV2RequestPermissionRequest(request: acp.RequestPermissionRequest): acpV2.RequestPermissionRequest {
    const meta = readPermissionMeta(request._meta);
    const {title: toolCallTitle, ...toolCallWithoutTitle} = request.toolCall;
    const title = meta?.title ?? toolCallTitle;
    if (!title) {
        throw acp.RequestError.internalError(
            undefined,
            "'session/request_permission' request has no title to send on ACP v2",
        );
    }
    const {content, ...toolCallFields} = meta ? request.toolCall : toolCallWithoutTitle;
    const toolCall: acpV2.ToolCallUpdate = {
        ...toolCallFields,
        ...(content !== undefined ? {content: content && content.map(toV2ToolCallContent)} : {}),
    };
    return {
        sessionId: request.sessionId,
        title,
        ...(meta?.description ? {description: meta.description} : {}),
        subject: {type: "tool_call", toolCall},
        options: request.options,
        ...(request._meta !== undefined ? {_meta: request._meta} : {}),
    };
}

/**
 * v2's `RequestPermissionResponse` is wire-identical to v1's (same `outcome`/`_meta` fields),
 * except v2's `outcome` is an open union: a client may answer with a custom/future value instead
 * of `"cancelled"`/`"selected"`. Readers must check for `"selected"` explicitly rather than treat
 * anything other than `"cancelled"` as selected (ACP-ENUM-203).
 */
export function toV1RequestPermissionResponse(response: acpV2.RequestPermissionResponse): acp.RequestPermissionResponse {
    return response as unknown as acp.RequestPermissionResponse;
}
