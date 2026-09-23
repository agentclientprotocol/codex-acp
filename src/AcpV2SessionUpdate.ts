import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type {AcpSessionUpdate} from "./AcpSessionExtensions";
import {toV2ConfigOptions} from "./AcpV2ConfigOptions";

/**
 * `planId` of the structured (tool-driven) plan on v2. A session has at most one such plan and
 * every update replaces it, so a constant id is stable for the whole session.
 */
export const STRUCTURED_PLAN_ID = "codex-structured-plan";

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
        case "config_option_update":
            return {...update, configOptions: toV2ConfigOptions(update.configOptions)};
        case "plan": {
            const {entries, _meta} = update;
            return {
                sessionUpdate: "plan_update",
                plan: {type: "items", planId: STRUCTURED_PLAN_ID, entries},
                ...(_meta != null ? {_meta} : {}),
            };
        }
        // v2 command input is a tagged union; v1 input is the untagged text form.
        case "available_commands_update":
            return {
                ...update,
                availableCommands: update.availableCommands.map((command) => ({
                    ...command,
                    ...(command.input != null ? {input: {...command.input, type: "text" as const}} : {}),
                })),
            };
        // v2 removed the modes API. codex-acp never emits this (mode changes go out as
        // `config_option_update`), so there is no v2 rendering to give it.
        case "current_mode_update":
            throw acp.RequestError.internalError(
                undefined,
                "'current_mode_update' session update does not exist in ACP v2",
            );
        // Topic 6: v2 message chunks require `messageId`.
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
        // Topic 6: v2 merges `tool_call` into `tool_call_update` and reshapes diff/terminal content.
        case "tool_call":
        case "tool_call_update":
        // Extension updates have no v2 shape yet.
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
