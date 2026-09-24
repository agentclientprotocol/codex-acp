import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {formatPatch, structuredPatch, type StructuredPatch} from "diff";
import {randomUUID} from "node:crypto";
import * as path from "node:path";
import type {AcpSessionUpdate} from "./AcpSessionExtensions";
import {toV2ConfigOptions} from "./AcpV2ConfigOptions";
import {stripShellPrefix} from "./CommandUtils";

/**
 * `planId` of the structured (tool-driven) plan on v2. A session has at most one such plan and
 * every update replaces it, so a constant id is stable for the whole session.
 */
export const STRUCTURED_PLAN_ID = "codex-structured-plan";

/**
 * Renders an internal (v1-shaped) session update as the ACP v2 updates to send, in order.
 *
 * v1 carries agent-owned command output in private tool call `_meta` keys. On v2 these become
 * standard `terminal_update`/`terminal_output_chunk` updates sent before the rest of the tool
 * call update, and never reach the client as `_meta`. An update that only carried terminal
 * output renders to no tool call update at all.
 */
export function toV2SessionUpdates(update: AcpSessionUpdate): acpV2.SessionUpdate[] {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return [toV2SessionUpdate(update)];
    }
    const {_meta, ...toolCall} = update;
    if (_meta == null || !TERMINAL_META_KEYS.some(key => key in _meta)) {
        return [toV2SessionUpdate(update)];
    }
    const {terminal_info, terminal_output, terminal_output_delta, terminal_exit, ...otherMeta} = _meta;
    const terminalUpdates = toV2TerminalUpdates(
        {info: terminal_info, output: terminal_output ?? terminal_output_delta, exit: terminal_exit},
        toolCall.rawInput,
    );
    const {sessionUpdate: _tag, toolCallId: _id, ...toolCallFields} = toolCall;
    if (Object.keys(toolCallFields).length === 0 && Object.keys(otherMeta).length === 0) {
        return terminalUpdates;
    }
    return [
        ...terminalUpdates,
        toV2SessionUpdate({...toolCall, ...(Object.keys(otherMeta).length > 0 ? {_meta: otherMeta} : {})}),
    ];
}

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

/** Renders a v1 tool call content item in the ACP v2 shape. Shared with permission requests. */
export function toV2ToolCallContent(content: acp.ToolCallContent): acpV2.ToolCallContent {
    switch (content.type) {
        case "content":
            return content;
        // Same shape on v2; the terminal itself is sent by `toV2SessionUpdates`.
        case "terminal":
            return content;
        case "diff":
            return {type: "diff", ...toV2Diff(content)};
    }
}

/** Private diff `_meta` key with the source path of a moved file (v1 only names the destination). */
export const DIFF_OLD_PATH_META_KEY = "diff_old_path";

/**
 * v2 diffs describe the change in `changes[]` and carry a git patch instead of whole-file
 * `oldText`/`newText`. The patch is generated from the v1 texts, so it is correct whatever form
 * Codex reported the change in (added and deleted files come as raw content, not as a diff).
 */
function toV2Diff(content: acp.Diff): acpV2.Diff {
    const {[DIFF_OLD_PATH_META_KEY]: oldPathMeta, ...meta} = content._meta ?? {};
    if (oldPathMeta !== undefined && typeof oldPathMeta !== "string") {
        throw acp.RequestError.internalError(undefined, `Malformed '${DIFF_OLD_PATH_META_KEY}' diff metadata`);
    }
    const kind = meta["kind"];
    const newPath = content.path;
    const oldPath = oldPathMeta ?? newPath;
    let change: acpV2.DiffChange;
    const patch: StructuredPatch = {
        ...structuredPatch(oldPath, newPath, content.oldText ?? "", content.newText, undefined, undefined, {context: 3}),
        isGit: true,
    };
    switch (kind) {
        case "add":
            change = {operation: "add", path: newPath};
            patch.oldFileName = "/dev/null";
            patch.isCreate = true;
            break;
        case "delete":
            change = {operation: "delete", path: newPath};
            patch.newFileName = "/dev/null";
            patch.isDelete = true;
            break;
        case "update":
            if (oldPath === newPath) {
                change = {operation: "modify", path: newPath};
            } else {
                change = {operation: "move", oldPath, path: newPath};
                patch.isRename = true;
            }
            break;
        default:
            throw acp.RequestError.internalError(undefined, `Diff content without a known 'kind': ${String(kind)}`);
    }
    return {
        changes: [change],
        patch: {format: "git_patch", text: formatPatch(patch)},
        ...(Object.keys(meta).length > 0 ? {_meta: meta} : {}),
    };
}

/** Private v1 `_meta` keys that carry agent-owned command output on a tool call update. */
const TERMINAL_META_KEYS = ["terminal_info", "terminal_output", "terminal_output_delta", "terminal_exit"];

type TerminalMeta = {info: unknown; output: unknown; exit: unknown};

type TerminalMetaRecord = {
    terminal_id: string;
    cwd?: unknown;
    data?: unknown;
    exit_code?: unknown;
    signal?: unknown;
};

/**
 * `terminal_info` announces the terminal (its `cwd`; the command is the tool call's
 * `rawInput.command` without the shell wrapper, the same text as the tool call title), `terminal_output`/`terminal_output_delta` carry output to append, and
 * `terminal_exit` marks completion. Output sent together with the exit is the command's whole
 * output (it is only sent when none was streamed), so it becomes the final snapshot.
 */
function toV2TerminalUpdates(meta: TerminalMeta, rawInput: unknown): acpV2.SessionUpdate[] {
    const info = meta.info == null ? null : terminalMetaRecord(meta.info, "terminal_info");
    const output = meta.output == null ? null : terminalMetaRecord(meta.output, "terminal_output");
    const exit = meta.exit == null ? null : terminalMetaRecord(meta.exit, "terminal_exit");
    const terminalId = (info ?? output ?? exit)!.terminal_id;

    const terminalUpdate: acpV2.TerminalUpdate = {terminalId};
    if (info) {
        const command = (rawInput as {command?: unknown} | null | undefined)?.command;
        if (typeof command === "string") {
            terminalUpdate.command = stripShellPrefix(command);
        }
        // v2 requires an absolute `cwd`; history fallbacks may not know it.
        if (typeof info.cwd === "string" && path.isAbsolute(info.cwd)) {
            terminalUpdate.cwd = info.cwd;
        }
    }
    const data = output ? base64(output.data, "terminal_output") : null;
    if (exit) {
        if (data !== null) {
            terminalUpdate.output = {data};
        }
        terminalUpdate.exitStatus = {
            exitCode: typeof exit.exit_code === "number" ? exit.exit_code : null,
            signal: typeof exit.signal === "string" ? exit.signal : null,
        };
    }

    const updates: acpV2.SessionUpdate[] = [];
    if (info || exit) {
        updates.push({sessionUpdate: "terminal_update", ...terminalUpdate});
    }
    if (data !== null && !exit) {
        updates.push({sessionUpdate: "terminal_output_chunk", terminalId, data});
    }
    return updates;
}

function terminalMetaRecord(value: unknown, key: string): TerminalMetaRecord {
    if (typeof value !== "object" || value === null || typeof (value as {terminal_id?: unknown}).terminal_id !== "string") {
        throw acp.RequestError.internalError(undefined, `Malformed '${key}' tool call metadata`);
    }
    return value as TerminalMetaRecord;
}

/** v2 terminal bytes are base64; Codex reports output as already-decoded text. */
function base64(data: unknown, key: string): string {
    if (typeof data !== "string") {
        throw acp.RequestError.internalError(undefined, `Malformed '${key}' tool call metadata`);
    }
    return Buffer.from(data, "utf8").toString("base64");
}
