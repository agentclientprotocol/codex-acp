import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { applyPatch, parsePatch, reversePatch } from "diff";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UpdateSessionEvent } from "./ACPSessionConnection";
import { stripShellPrefix } from "./CommandUtils";
import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification
} from "./app-server";
import type {
    CommandAction,
    CommandExecutionStatus,
    DynamicToolCallStatus,
    FileUpdateChange,
    McpToolCallError,
    McpToolCallResult,
    McpToolCallStatus,
    PatchApplyStatus,
    ThreadItem,
} from "./app-server/v2";
import type { JsonValue } from "./app-server/serde_json/JsonValue";
import {logger} from "./Logger";

type CodexItemStatus = CommandExecutionStatus | PatchApplyStatus | McpToolCallStatus | DynamicToolCallStatus;
type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

function toAcpStatus(status: CodexItemStatus): AcpToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "completed":
            return "completed";
        case "failed":
        case "declined":
            return "failed";
    }
}

export async function createFileChangeUpdate(
    item: ThreadItem & { type: "fileChange" }
): Promise<UpdateSessionEvent> {
    const patches: ToolCallContent[] = [];
    for (const change of item.changes) {
        const content = await createPatchContent(change);
        if (content) patches.push(content);
        // ignore unparseable diffs
    }
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        title: "Editing files",
        kind: "edit",
        status: toAcpStatus(item.status),
        content: patches,
    };
}

export async function createCommandExecutionUpdate(
    item: ThreadItem & { type: "commandExecution" }
): Promise<UpdateSessionEvent> {
    const commandAction = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
    if (commandAction) {
        return createCommandActionEvent(item.id, item.status, item.cwd, commandAction);
    }
    const command = stripShellPrefix(item.command);
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "execute",
        title: command,
        status: toAcpStatus(item.status),
        content: [{ type: "terminal", terminalId: item.id }],
        rawInput: {
            command: item.command,
            cwd: item.cwd,
        },
        _meta: {
            terminal_info: {
                cwd: item.cwd,
                terminal_id: item.id,
            },
        },
    };
}

export async function createMcpToolCallUpdate(
    item: ThreadItem & { type: "mcpToolCall" }
): Promise<UpdateSessionEvent> {
    return {
        ...await createExecuteToolCallUpdate(
            item,
            `mcp.${item.server}.${item.tool}`,
            createMcpRawInput(item.server, item.tool, item.arguments),
            createMcpRawOutput(item.result, item.error),
        ),
        _meta: { is_mcp_tool_call: true },
    };
}

export async function createDynamicToolCallUpdate(
    item: ThreadItem & { type: "dynamicToolCall" }
): Promise<UpdateSessionEvent> {
    return createExecuteToolCallUpdate(item, item.tool, { arguments: item.arguments })
}

export async function createExecuteToolCallUpdate(
    item: ThreadItem & ({ type: "mcpToolCall" } | { type: "dynamicToolCall" }),
    title: string,
    rawInput?: Record<string, JsonValue | string>,
    rawOutput?: Record<string, JsonValue | string | null>,
): Promise<UpdateSessionEvent> {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "execute",
        title: title,
        status: toAcpStatus(item.status),
        rawInput: rawInput,
        rawOutput: rawOutput,
    };
}

export function createMcpRawInput(server: string, tool: string, argumentsValue: JsonValue): Record<string, JsonValue | string> {
    return {
        server,
        tool,
        arguments: argumentsValue,
    };
}

export function createMcpRawOutput(
    result: McpToolCallResult | null,
    error: McpToolCallError | null,
): Record<string, JsonValue | string | null> | undefined {
    if (result === null && error === null) {
        return undefined;
    }

    return {
        result,
        error,
    };
}

export function fuzzyFileSearchToolCallId(sessionId: string): string {
    return `fuzzyFileSearch.${sessionId}`;
}

export function createFuzzyFileSearchStartOrUpdate(
    event: FuzzyFileSearchSessionUpdatedNotification,
    started: boolean
): UpdateSessionEvent {
    const toolCallId = fuzzyFileSearchToolCallId(event.sessionId);
    const title = createSearchTitle(event.query, null);
    const locations = event.files.map((file) => ({
        path: path.isAbsolute(file.path) ? file.path : path.join(file.root, file.path),
    }));

    if (started) {
        return {
            sessionUpdate: "tool_call",
            toolCallId,
            kind: "search",
            title,
            status: "in_progress",
            locations,
            rawInput: {
                query: event.query,
            },
        };
    }

    return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title,
        status: "in_progress",
        locations,
    };
}

export function createFuzzyFileSearchComplete(
    event: FuzzyFileSearchSessionCompletedNotification
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: fuzzyFileSearchToolCallId(event.sessionId),
        status: "completed",
    };
}

function createCommandActionEvent(
    id: string,
    status: CommandExecutionStatus,
    cwd: string,
    commandAction: CommandAction
): UpdateSessionEvent {
    const acpStatus = toAcpStatus(status);
    if (commandAction.type === "read") {
        return {
            sessionUpdate: "tool_call",
            toolCallId: id,
            status: acpStatus,
            kind: "read",
            title: `Read file '${commandAction.path}'`,
            locations: [{ path: commandAction.path }],
        };
    } else if (commandAction.type === "search") {
        return {
            sessionUpdate: "tool_call",
            toolCallId: id,
            status: acpStatus,
            kind: "search",
            title: createSearchTitle(commandAction.query, commandAction.path),
        };
    } else if (commandAction.type === "listFiles") {
        const title = commandAction.path
            ? `List files in '${commandAction.path}'`
            : "List files";
        return {
            sessionUpdate: "tool_call",
            toolCallId: id,
            status: acpStatus,
            kind: "read",
            title: title,
        };
    }
    return {
        sessionUpdate: "tool_call",
        toolCallId: id,
        status: acpStatus,
        kind: "execute",
        title: stripShellPrefix(commandAction.command),
        content: [{ type: "terminal", terminalId: id }],
        rawInput: {
            command: commandAction.command,
            cwd,
        },
        _meta: {
            terminal_info: {
                cwd,
                terminal_id: id,
            },
        },
    };
}

function createSearchTitle(query: string | null, path: string | null): string {
    if (query && path) {
        return `Search for '${query}' in ${path}`;
    } else if (query) {
        return `Search for '${query}'`;
    } else if (path) {
        return `Search in '${path}'`;
    }
    return "Search";
}

async function createPatchContent(change: FileUpdateChange): Promise<ToolCallContent | null> {
    try {
        switch (change.kind.type) {
            case "add":
                return await createAddFileContent(change);
            case "delete":
                return await createDeleteFileContent(change);
            case "update":
                return await createUpdateFileContent(change);
        }
    } catch (error) {
        logger.log(`Error processing file update change: ${error}`);
        return null;
    }
}

async function createAddFileContent(change: FileUpdateChange): Promise<ToolCallContent | null> {
    return {
        type: "diff",
        oldText: null,
        newText: change.diff, // app-server always returns file content instead of diff
        path: change.path,
        _meta: {
            kind: "add",
        },
    };
}

async function createUpdateFileContent(change: FileUpdateChange): Promise<ToolCallContent | null> {
    if (change.kind.type !== "update") return null;

    const unifiedDiff = recoverCorruptedDiff(change.diff);
    const movePath = change.kind.move_path;

    const oldContent = await readFileContent(change.path);
    if (oldContent !== null) {
        const patchedContent = applyPatch(oldContent, unifiedDiff);
        if (patchedContent === false) return null;
        return createUpdateDiffContent(movePath ?? change.path, oldContent, patchedContent);
    }

    if (!movePath) return null;
    const newContent = await readFileContent(movePath);
    if (newContent === null) return null;

    const revertedPatch = revertPatch(unifiedDiff);
    if (!revertedPatch) return null;

    const revertedContent = applyPatch(newContent, revertedPatch);
    if (revertedContent === false) return null;

    return createUpdateDiffContent(movePath, revertedContent, newContent);
}

function revertPatch(unifiedDiff: string) {
    const [patch] = parsePatch(unifiedDiff);
    if (!patch) return null;

    return reversePatch(patch);
}

function createUpdateDiffContent(path: string, oldText: string, newText: string): ToolCallContent {
    return {
        type: "diff",
        oldText,
        newText,
        path,
        _meta: {
            kind: "update",
        },
    };
}

async function createDeleteFileContent(change: FileUpdateChange): Promise<ToolCallContent> {
    return {
        type: "diff",
        oldText: change.diff, // app-server always returns file content instead of diff
        newText: "",
        path: change.path,
        _meta: {
            kind: "delete",
        }
    }
}

async function readFileContent(filePath: string): Promise<string | null> {
    return await readFile(filePath, { encoding: "utf8" }).catch(() => null);
}

/**
 * Fix unified diff content corrupted by codex agent.
 * Removes synthetic "Moved to" from the end.
 */
function recoverCorruptedDiff(diff: string): string {
    return diff.replace(/\n\nMoved to: .*$/, "");
}
