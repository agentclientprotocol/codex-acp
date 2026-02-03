import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { applyPatch } from "diff";
import { readFile } from "node:fs/promises";
import type { UpdateSessionEvent } from "./ACPSessionConnection";
import { stripShellPrefix } from "./CommandUtils";
import type {
    CommandAction,
    CommandExecutionStatus,
    FileUpdateChange,
    McpToolCallStatus,
    PatchApplyStatus,
    ThreadItem,
} from "./app-server/v2";

type CodexItemStatus = CommandExecutionStatus | PatchApplyStatus | McpToolCallStatus;
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
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "execute",
        title: `mcp.${item.server}.${item.tool}`,
        status: toAcpStatus(item.status),
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

    const oldContent = change.kind.type === "add" ? "" : await readFile(change.path, { encoding: "utf8" });
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
