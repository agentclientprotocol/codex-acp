import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { applyPatch, parsePatch } from "diff";
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
    return createExecuteToolCallUpdate(
        item,
        `mcp.${item.server}.${item.tool}`,
        createMcpRawInput(item.server, item.tool, item.arguments),
        createMcpRawOutput([], item.result, item.error),
    );
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
    const invocation = `Called ${server}.${tool} (${formatJsonInline(argumentsValue)})`;
    return {
        server,
        tool,
        arguments: argumentsValue,
        invocation,
        prettyArguments: formatJsonPretty(argumentsValue),
    };
}

export function createMcpRawOutput(
    logs: Array<string>,
    result: McpToolCallResult | null,
    error: McpToolCallError | null,
): Record<string, JsonValue | string | null> | undefined {
    const logLines = normalizeMcpLogLines(logs, error, result);
    if (logLines.length === 0) {
        return undefined;
    }

    return {
        formatted_output: logLines.join("\n\n"),
        result,
        error,
    };
}

function formatMcpResult(result: McpToolCallResult | null): string | null {
    if (!result) {
        return null;
    }

    const parts: string[] = [];
    if (result.content.length > 0) {
        parts.push(result.content.map((contentItem) => formatJsonPretty(contentItem)).join("\n"));
    }
    if (result.structuredContent !== null) {
        parts.push(formatJsonPretty(result.structuredContent));
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
}

function normalizeMcpLogLines(
    logs: Array<string>,
    error: McpToolCallError | null,
    result: McpToolCallResult | null,
): Array<string> {
    const lines: string[] = [];
    const seen = new Set<string>();

    const append = (value: string | null | undefined) => {
        const cleaned = value?.trim();
        if (!cleaned || seen.has(cleaned)) {
            return;
        }
        seen.add(cleaned);
        lines.push(cleaned);
    };

    for (const log of logs) {
        append(log);
    }
    append(error?.message);
    append(formatMcpResult(result));

    return lines;
}

function formatJsonInline(value: JsonValue): string {
    return JSON.stringify(value);
}

function formatJsonPretty(value: JsonValue): string {
    return JSON.stringify(value, null, 2);
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
            title: "Read file",
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
    if (change.kind.type === "add" && !isUnifiedDiff(change.diff)) {
        // For new files, diff may contain raw file content instead of a patch.
        return {
            type: "diff",
            oldText: null,
            newText: change.diff,
            path: change.path,
            _meta: {
                kind: "add",
            },
        };
    }

    if (change.kind.type === "delete") {
        // If the patch deletes a file, the old content may be only available from the diff.
        const oldContent = await readFile(change.path, { encoding: "utf8"} ).catch(() =>
            isUnifiedDiff(change.diff) ? patchToDeletedContent(change.diff) : change.diff
        );

        return {
            type: "diff",
            oldText: oldContent,
            newText: "",
            path: change.path,
            _meta: {
                kind: "delete",
            }
        }
    }

    const oldContent = change.kind.type === "add" ? "" : await readFile(change.path, { encoding: "utf8" }).catch(() => null);
    if (oldContent === null) {
        return null;
    }

    const newContent = applyPatch(oldContent, change.diff);
    if (newContent === false) {
        return null;
    }
    return {
        type: "diff",
        oldText: change.kind.type === "add" ? null : oldContent,
        newText: newContent,
        path: change.path,
        _meta: {
            kind: change.kind.type,
        },
    };
}

function isUnifiedDiff(content: string): boolean {
    return content.startsWith("--- ") || content.includes("\n--- ");
}

/**
 * Recreates the content of a deleted file from the unified diff.
 * @param unifiedDiff The unified diff of the file deletion patch
 */
function patchToDeletedContent(unifiedDiff: string): string | null {
    try {
        const [patch] = parsePatch(unifiedDiff);
        if (!patch || patch.hunks.length === 0) {
            return null;
        }

        const oldLines: string[] = [];
        let hasNoTrailingNewlineMarker = false;

        for (const hunk of patch.hunks) {
            for (const line of hunk.lines) {
                if (line === "\\ No newline at end of file") {
                    hasNoTrailingNewlineMarker = true;
                    continue;
                }
                if (line.startsWith("-") || line.startsWith(" ")) {
                    oldLines.push(line.slice(1));
                }
            }
        }

        if (oldLines.length === 0) {
            return "";
        }

        const oldText = oldLines.join("\n");
        return hasNoTrailingNewlineMarker || !unifiedDiff.endsWith("\n") ? oldText : `${oldText}\n`;
    } catch {
        return null;
    }
}
