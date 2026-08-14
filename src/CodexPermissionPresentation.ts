import type * as acp from "@agentclientprotocol/sdk";
import type {
    CommandAction,
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
    RequestPermissionProfile,
    ThreadItem,
} from "./app-server/v2";
import {stripShellPrefix} from "./CodexEventHandler";
import type {CodexApprovalPresentationStore} from "./CodexApprovalPresentationStore";

type FileChangeItem = ThreadItem & {type: "fileChange"};

export function commandToolCall(
    params: CommandExecutionRequestApprovalParams,
): acp.ToolCallUpdate {
    const network = params.networkApprovalContext;
    const rawInput = {
        ...(params.command ? {command: stripShellPrefix(params.command)} : {}),
        ...(params.cwd ? {cwd: params.cwd} : {}),
    };
    return {
        toolCallId: params.itemId,
        kind: "execute",
        status: "pending",
        title: network
            ? `${network.protocol} network access to ${network.host}`
            : commandTitle(params.commandActions),
        ...(Object.keys(rawInput).length > 0 ? {rawInput} : {}),
        ...locationsField(commandActionPaths(params.commandActions)),
        ...(network ? {content: [textContent(`${network.protocol} access to ${network.host}`)]} : {}),
    };
}

export function fileChangeToolCall(
    params: FileChangeRequestApprovalParams,
    store: CodexApprovalPresentationStore,
): acp.ToolCallUpdate {
    const item = store.fileChange(params.itemId);
    return {
        toolCallId: params.itemId,
        kind: "edit",
        status: "pending",
        title: "Edit files",
        ...locationsField(fileChangePaths(item)),
    };
}

export function additionalPermissionsToolCall(
    itemId: string,
    cwd: string,
    environmentId: string | null,
    permissions: RequestPermissionProfile,
): acp.ToolCallUpdate {
    const content = permissionProfileContent(permissions);
    return {
        toolCallId: itemId,
        kind: "other",
        status: "pending",
        title: "Additional sandbox permissions",
        rawInput: {permissions, cwd, environmentId},
        ...locationsField(permissionProfilePaths(permissions)),
        ...(content.length > 0 ? {content} : {}),
    };
}

function commandTitle(actions?: CommandAction[] | null): string {
    const first = actions?.[0];
    if (!first) return "Run command";
    switch (first.type) {
        case "read":
            return actions?.length === 1 ? "Read file" : "Run command with file reads";
        case "listFiles":
            return "List files";
        case "search":
            return "Search files";
        case "unknown":
            return "Run command";
    }
}

function commandActionPaths(actions?: CommandAction[] | null): string[] {
    return unique((actions ?? []).flatMap(action => {
        switch (action.type) {
            case "read":
                return [action.path];
            case "listFiles":
            case "search":
                return action.path ? [action.path] : [];
            case "unknown":
                return [];
        }
    }));
}

function fileChangePaths(item?: FileChangeItem): string[] {
    return unique(item?.changes.map(change => change.path) ?? []);
}

function permissionProfilePaths(permissions: RequestPermissionProfile): string[] {
    const fileSystem = permissions.fileSystem;
    return unique([
        ...(fileSystem?.read ?? []),
        ...(fileSystem?.write ?? []),
        ...(fileSystem?.entries ?? []).flatMap(entry =>
            entry.path.type === "path" ? [entry.path.path] : []),
    ]);
}

function permissionProfileContent(permissions: RequestPermissionProfile): acp.ToolCallContent[] {
    const lines: string[] = [];
    const networkEnabled = permissions.network?.enabled;
    if (networkEnabled !== null && networkEnabled !== undefined) {
        lines.push(networkEnabled ? "Enable network access" : "Disable network access");
    }
    for (const entry of permissions.fileSystem?.entries ?? []) {
        switch (entry.path.type) {
            case "glob_pattern":
                lines.push(`${entry.access} filesystem pattern ${entry.path.pattern}`);
                break;
            case "special":
                lines.push(`${entry.access} Codex filesystem scope ${JSON.stringify(entry.path.value)}`);
                break;
            case "path":
                break;
        }
    }
    return lines.length > 0 ? [textContent(lines.join("\n"))] : [];
}

function locationsField(paths: string[]): Pick<acp.ToolCallUpdate, "locations"> | object {
    return paths.length > 0 ? {locations: paths.map(path => ({path}))} : {};
}

function textContent(text: string): acp.ToolCallContent {
    return {type: "content", content: {type: "text", text}};
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}
