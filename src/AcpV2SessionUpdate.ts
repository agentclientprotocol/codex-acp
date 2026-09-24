import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {randomUUID} from "node:crypto";
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
        // v2 message chunks require `messageId`. A user message without one would not match the
        // `messageId` of its prompt response, so it is rejected rather than given a fresh id.
        case "user_message_chunk": {
            const {messageId} = update;
            if (messageId == null) {
                throw acp.RequestError.internalError(
                    undefined,
                    "'user_message_chunk' session update without a messageId is not supported on an ACP v2 connection",
                );
            }
            return {...update, messageId};
        }
        // Agent chunks without an id are one-off notices sent as a single chunk (warnings, errors,
        // slash-command replies), so each gets a fresh id and starts its own message. Replayed
        // history must carry its own ids instead, since they have to be the same on every replay.
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return {...update, messageId: update.messageId || randomUUID()};
        // v2 has no separate create: the first `tool_call_update` for an id creates the tool call.
        case "tool_call":
        case "tool_call_update": {
            const {content, ...rest} = update;
            return {
                ...rest,
                sessionUpdate: "tool_call_update",
                ...(content !== undefined ? {content: content && content.map(toV2ToolCallContent)} : {}),
            };
        }
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

function toV2ToolCallContent(content: acp.ToolCallContent): acpV2.ToolCallContent {
    switch (content.type) {
        case "content":
            return content;
        // v2 diffs carry `changes[]` + `patch` instead of `oldText`/`newText`.
        case "diff":
        // v2 terminal output is agent-streamed via `terminal_update`, which is not sent yet.
        case "terminal":
            throw acp.RequestError.internalError(
                undefined,
                `'${content.type}' tool call content is not supported on an ACP v2 connection yet`,
            );
    }
}
