import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type {AcpSessionUpdate} from "./AcpSessionExtensions";

/**
 * Renders an internal (v1-shaped) session update in the ACP v2 wire shape.
 *
 * The v2 SDK sends `session/update` params as-is, without validation, so a variant with no v2
 * rendering yet throws here instead of reaching a v2 client in the v1 shape.
 */
export function toV2SessionUpdate(update: AcpSessionUpdate): acpV2.SessionUpdate {
    switch (update.sessionUpdate) {
        // Same wire shape on v1 and v2.
        case "plan_update":
        case "plan_removed":
        case "session_info_update":
        case "usage_update":
        case "notice":
        case "compaction_update":
        case "compaction_summary_chunk":
            return update;
        // Topic 6: v2 message chunks require `messageId`.
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
        // Topic 6: v2 merges `tool_call` into `tool_call_update` and reshapes diff/terminal content.
        case "tool_call":
        case "tool_call_update":
        // Topic 9: v2 wraps plans in `plan_update`, removes modes, and renames `id` to `configId`.
        case "plan":
        case "current_mode_update":
        case "config_option_update":
        // Pending research: v2 command input carries a `type` tag; extension updates have no v2 shape yet.
        case "available_commands_update":
        case "subagent_spawned":
        case "subagent_state_update":
        case "async_task_spawned":
        case "async_task_progress":
        case "async_task_state_update":
            throw acp.RequestError.internalError(
                undefined,
                `'${update.sessionUpdate}' session update is not supported on an ACP v2 connection yet`,
            );
    }
}
