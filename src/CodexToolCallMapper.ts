import type { ContentBlock, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { parsePatch, type StructuredPatchHunk } from "diff";
import path from "node:path";
import type { UpdateSessionEvent } from "./ACPSessionConnection";
import { stripShellPrefix } from "./CommandUtils";
import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification
} from "./app-server";
import type {
    CollabAgentToolCallStatus,
    CommandAction,
    CommandExecutionStatus,
    DynamicToolCallStatus,
    FileChangePatchUpdatedNotification,
    FileUpdateChange,
    GuardianApprovalReview,
    GuardianApprovalReviewAction,
    GuardianApprovalReviewStatus,
    GuardianCommandSource,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
    McpToolCallError,
    McpToolCallResult,
    McpToolCallStatus,
    PatchApplyStatus,
    ThreadItem,
} from "./app-server/v2";
import type { JsonValue } from "./app-server/serde_json/JsonValue";
import {logger} from "./Logger";
import {
    createTerminalOutputMeta,
    type TerminalOutputMode,
} from "./TerminalOutputMode";

type CodexItemStatus = CommandExecutionStatus | PatchApplyStatus | McpToolCallStatus | DynamicToolCallStatus | CollabAgentToolCallStatus;
type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
type GuardianApprovalReviewNotification =
    | ItemGuardianApprovalReviewStartedNotification
    | ItemGuardianApprovalReviewCompletedNotification;
type WebSearchItem = ThreadItem & { type: "webSearch" };
type CollabAgentToolCallItem = ThreadItem & { type: "collabAgentToolCall" };
type SubAgentActivityItem = ThreadItem & { type: "subAgentActivity" };
type CommandExecutionItem = ThreadItem & { type: "commandExecution" };
type FileChangeItem = ThreadItem & { type: "fileChange" };
type ContextCompactionItem = ThreadItem & { type: "contextCompaction" };
type AcpToolCallEvent = Extract<UpdateSessionEvent, { sessionUpdate: "tool_call" }>;

const CONTEXT_COMPACTION_META = { contextCompaction: true };

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
    item: FileChangeItem
): Promise<UpdateSessionEvent> {
    const rawOutput = createFileChangeRawOutput(item);
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        title: "Editing files",
        kind: "edit",
        status: toAcpStatus(item.status),
        content: await createFileChangeContent(item.changes),
        locations: createFileChangeLocations(item.changes),
        rawInput: createFileChangeRawInput(item.changes),
        ...(rawOutput === undefined ? {} : { rawOutput }),
    };
}

export async function createFileChangePatchUpdate(
    notification: FileChangePatchUpdatedNotification,
): Promise<UpdateSessionEvent> {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: notification.itemId,
        status: "in_progress",
        content: await createFileChangeContent(notification.changes),
        locations: createFileChangeLocations(notification.changes),
        rawInput: createFileChangeRawInput(notification.changes),
    };
}

export function createFileChangeCompleteUpdate(item: FileChangeItem): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: item.id,
        status: toAcpStatus(item.status),
        rawOutput: createFileChangeRawOutput(item),
    };
}

export async function createCommandExecutionUpdate(item: CommandExecutionItem): Promise<UpdateSessionEvent> {
    const commandAction = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
    if (commandAction) {
        return createCommandActionEvent(item.id, item.status, item.cwd, commandAction);
    }
    const command = stripShellPrefix(item.command);
    return createTerminalCommandEvent({
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "execute",
        title: command,
        status: toAcpStatus(item.status),
        rawInput: {
            command: item.command,
            cwd: item.cwd,
        },
    }, item.id, item.cwd);
}

export function createCommandExecutionCompleteUpdate(
    item: CommandExecutionItem,
    terminalOutputMode: TerminalOutputMode,
): UpdateSessionEvent | null {
    if (item.status === "inProgress") {
        return null;
    }

    const update: UpdateSessionEvent = {
        sessionUpdate: "tool_call_update",
        toolCallId: item.id,
        status: item.status === "completed" ? "completed" : "failed",
        rawOutput: {
            formatted_output: item.aggregatedOutput ?? "",
            exit_code: item.exitCode,
        },
    };

    if (!commandExecutionUsesTerminalOutput(item)) {
        return update;
    }

    const terminalMeta: Record<string, unknown> = {};
    if (item.aggregatedOutput) {
        Object.assign(
            terminalMeta,
            createTerminalOutputMeta(terminalOutputMode, item.id, item.aggregatedOutput),
        );
    }
    terminalMeta["terminal_exit"] = {
        exit_code: item.exitCode,
        signal: null,
        terminal_id: item.id,
    };

    return {
        ...update,
        _meta: terminalMeta,
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

export function createImageViewUpdate(
    item: ThreadItem & { type: "imageView" }
): UpdateSessionEvent {
    const displayPath = item.path;
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "read",
        title: `View Image ${displayPath}`,
        status: "completed",
        content: [createContent({
            type: "resource_link",
            name: displayPath,
            uri: displayPath,
        })],
        locations: [{ path: item.path }],
        rawInput: {
            path: item.path,
        },
    };
}

export function createImageGenerationStartUpdate(
    item: ThreadItem & { type: "imageGeneration" }
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        title: "Image generation",
        status: "in_progress",
        rawInput: {
            id: item.id,
        },
    };
}

export function createImageGenerationCompleteUpdate(
    item: ThreadItem & { type: "imageGeneration" }
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: item.id,
        status: imageGenerationTerminalStatus(item.status),
        content: imageGenerationContent(item),
        rawOutput: imageGenerationRawOutput(item),
    };
}

export function createImageGenerationUpdate(
    item: ThreadItem & { type: "imageGeneration" },
    options?: { terminalStatus?: boolean },
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        title: "Image generation",
        status: options?.terminalStatus
            ? imageGenerationTerminalStatus(item.status)
            : imageGenerationToolStatus(item.status),
        content: imageGenerationContent(item),
        rawOutput: imageGenerationRawOutput(item),
    };
}

export function createContextCompactionStartUpdate(
    item: ContextCompactionItem,
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        title: "Context compacting",
        status: "in_progress",
        _meta: CONTEXT_COMPACTION_META,
    };
}

export function createContextCompactionCompleteUpdate(
    item: ContextCompactionItem,
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: item.id,
        title: "Context compacted",
        status: "completed",
        _meta: CONTEXT_COMPACTION_META,
    };
}

export function createCompletedContextCompactionUpdate(
    item: ContextCompactionItem,
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        title: "Context compacted",
        status: "completed",
        _meta: CONTEXT_COMPACTION_META,
    };
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

export function guardianApprovalReviewToolCallId(reviewId: string): string {
    return `guardian_assessment:${reviewId}`;
}

export function createGuardianApprovalReviewToolCall(
    event: GuardianApprovalReviewNotification,
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: guardianApprovalReviewToolCallId(event.reviewId),
        kind: "think",
        title: "Guardian Review",
        status: toAcpGuardianApprovalReviewStatus(event.review.status),
        content: createGuardianApprovalReviewContent(event.review, event.action),
        rawInput: event as unknown as Record<string, JsonValue>,
    };
}

export function createGuardianApprovalReviewToolCallUpdate(
    event: GuardianApprovalReviewNotification,
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: guardianApprovalReviewToolCallId(event.reviewId),
        status: toAcpGuardianApprovalReviewStatus(event.review.status),
        content: createGuardianApprovalReviewContent(event.review, event.action),
        rawOutput: event as unknown as Record<string, JsonValue>,
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

export function createWebSearchStartUpdate(
    item: WebSearchItem
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "search",
        title: formatWebSearchTitle(item),
        status: "in_progress",
        rawInput: createWebSearchRawInput(item),
    };
}

export function createWebSearchCompleteUpdate(
    item: WebSearchItem
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: item.id,
        title: formatWebSearchTitle(item),
        status: "completed",
        rawInput: createWebSearchRawInput(item),
    };
}

function createWebSearchRawInput(item: WebSearchItem): Record<string, JsonValue> {
    return {
        type: item.type,
        id: item.id,
        query: item.query,
        action: item.action,
    };
}

export function createCollabAgentToolCallUpdate(
    item: CollabAgentToolCallItem
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        title: item.tool,
        status: toAcpStatus(item.status),
        rawInput: createCollabAgentToolCallRawInput(item),
        _meta: createCollabAgentToolCallMeta(item),
    };
}

export function createCollabAgentToolCallCompleteUpdate(
    item: CollabAgentToolCallItem
): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: item.id,
        title: item.tool,
        status: toAcpStatus(item.status),
        rawInput: createCollabAgentToolCallRawInput(item),
        _meta: createCollabAgentToolCallMeta(item),
    };
}

function createCollabAgentToolCallRawInput(item: CollabAgentToolCallItem) {
    return {
        prompt: item.prompt,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        status: item.status,
    };
}

function createCollabAgentToolCallMeta(item: CollabAgentToolCallItem) {
    return {
        codex: {
            collaboration: {
                tool: item.tool,
                senderThreadId: item.senderThreadId,
                receiverThreadIds: item.receiverThreadIds,
            },
        },
    };
}

export function createSubAgentActivityUpdate(
    item: SubAgentActivityItem,
    status: "in_progress" | "completed",
    sessionUpdate: "tool_call" | "tool_call_update",
): UpdateSessionEvent {
    const name = item.agentPath.split("/").filter(Boolean).at(-1) ?? "subagent";
    const title = formatSubAgentActivityTitle(item.kind, name);
    const common = {
        toolCallId: item.id,
        status,
        rawInput: {
            agentThreadId: item.agentThreadId,
            agentPath: item.agentPath,
            activityKind: item.kind,
        },
        _meta: {
            codex: {
                subagent: {
                    threadId: item.agentThreadId,
                    path: item.agentPath,
                    activity: item.kind,
                },
            },
        },
    };
    if (sessionUpdate === "tool_call") {
        return {
            sessionUpdate,
            title,
            kind: "other",
            ...common,
        };
    }
    return {
        sessionUpdate,
        ...common,
    };
}

function formatSubAgentActivityTitle(kind: SubAgentActivityItem["kind"], name: string): string {
    switch (kind) {
        case "started":
            return `Start subagent ${name}`;
        case "interacted":
            return `Interact with subagent ${name}`;
        case "interrupted":
            return `Interrupt subagent ${name}`;
    }
}

export function formatWebSearchTitle(item: WebSearchItem): string {
    const action = item.action;
    if (!action) {
        return item.query ? `Web search: ${item.query}` : "Web search";
    }
    switch (action.type) {
        case "search": {
            const queries = action.queries?.filter((query) => query && query.length > 0) ?? [];
            const query = action.query ?? (queries.length > 0 ? queries.join(", ") : null) ?? item.query;
            return query ? `Web search: ${query}` : "Web search";
        }
        case "openPage":
            return action.url ? `Open page: ${action.url}` : "Open page";
        case "findInPage": {
            const pattern = action.pattern ? ` for '${action.pattern}'` : "";
            const url = action.url ? ` in ${action.url}` : "";
            return `Find in page${pattern}${url}`.trim();
        }
        case "other":
            return "Web search";
    }
}

export function createCommandActionEvent(
    id: string,
    status: CommandExecutionStatus,
    cwd: string,
    commandAction: CommandAction
): AcpToolCallEvent {
    const acpStatus = toAcpStatus(status);
    switch (commandAction.type) {
        case "read":
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: acpStatus,
                kind: "read",
                title: `Read file '${commandAction.path}'`,
                locations: [{ path: commandAction.path }],
            };
        case "search":
            return {
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: acpStatus,
                kind: "search",
                title: createSearchTitle(commandAction.query, commandAction.path),
            };
        case "listFiles": {
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
        case "unknown":
            return createTerminalCommandEvent({
                sessionUpdate: "tool_call",
                toolCallId: id,
                status: acpStatus,
                kind: "execute",
                title: stripShellPrefix(commandAction.command),
                rawInput: {
                    command: commandAction.command,
                    cwd,
                },
            }, id, cwd);
    }
}

export function commandExecutionUsesTerminalOutput(item: CommandExecutionItem): boolean {
    const commandAction = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
    return commandAction === undefined || commandAction.type === "unknown";
}

function createTerminalCommandEvent(
    event: AcpToolCallEvent,
    terminalId: string,
    cwd: string,
): AcpToolCallEvent {
    const { rawInput, ...eventWithoutRawInput } = event;
    return {
        ...eventWithoutRawInput,
        content: [{ type: "terminal", terminalId }],
        ...(rawInput === undefined ? {} : { rawInput }),
        _meta: {
            terminal_info: {
                cwd,
                terminal_id: terminalId,
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

function toAcpGuardianApprovalReviewStatus(status: GuardianApprovalReviewStatus): AcpToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "approved":
            return "completed";
        case "denied":
        case "aborted":
        case "timedOut":
            return "failed";
    }
}

function createGuardianApprovalReviewContent(
    review: GuardianApprovalReview,
    action: GuardianApprovalReviewAction,
): ToolCallContent[] {
    const lines = [`Status: ${formatGuardianApprovalReviewStatus(review.status)}`];
    const actionSummary = createGuardianApprovalReviewActionSummary(action);
    if (actionSummary) {
        lines.push(`Action: ${actionSummary}`);
    }
    if (review.riskLevel) {
        lines.push(`Risk: ${review.riskLevel}`);
    }
    if (review.userAuthorization) {
        lines.push(`Authorization: ${review.userAuthorization}`);
    }
    if (review.rationale?.trim()) {
        lines.push(`Rationale: ${review.rationale}`);
    }

    return [{
        type: "content",
        content: {
            type: "text",
            text: lines.join("\n"),
        },
    }];
}

function formatGuardianApprovalReviewStatus(status: GuardianApprovalReviewStatus): string {
    switch (status) {
        case "inProgress":
            return "In progress";
        case "approved":
            return "Approved";
        case "denied":
            return "Denied";
        case "aborted":
            return "Aborted";
        case "timedOut":
            return "Timed out";
    }
}

function createGuardianApprovalReviewActionSummary(action: GuardianApprovalReviewAction): string | null {
    switch (action.type) {
        case "command":
            return `${guardianCommandSourceLabel(action.source)} ${action.command}`;
        case "execve": {
            const command = action.argv.length > 0 ? action.argv : [action.program];
            return `${guardianCommandSourceLabel(action.source)} ${shellJoin(command)}`;
        }
        case "applyPatch":
            if (action.files.length === 1) {
                return `apply_patch touching ${action.files[0]}`;
            }
            return `apply_patch touching ${action.files.length} files`;
        case "networkAccess": {
            const label = action.target.length > 0 ? action.target : action.host;
            return `network access to ${label}`;
        }
        case "mcpToolCall": {
            const label = action.connectorName ?? action.server;
            return `MCP ${action.toolName} on ${label}`;
        }
        case "requestPermissions":
            return action.reason ?? "request additional permissions";
    }
}

function guardianCommandSourceLabel(source: GuardianCommandSource): string {
    switch (source) {
        case "shell":
            return "shell";
        case "unifiedExec":
            return "exec";
    }
}

function shellJoin(args: string[]): string {
    return args.map(shellQuote).join(" ");
}

function shellQuote(arg: string): string {
    if (arg.length === 0) {
        return "''";
    }
    if (/^[A-Za-z0-9_/:=+.,@%-]+$/.test(arg)) {
        return arg;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function imageGenerationToolStatus(status: string): AcpToolCallStatus {
    switch (status) {
        case "completed":
            return "completed";
        case "generating":
        case "in_progress":
        case "inProgress":
        case "incomplete":
            return "in_progress";
        case "failed":
            return "failed";
        default:
            return "completed";
    }
}

function imageGenerationTerminalStatus(status: string): AcpToolCallStatus {
    switch (status) {
        case "failed":
            return "failed";
        case "completed":
        case "generating":
        case "in_progress":
        case "inProgress":
        case "incomplete":
        default:
            return "completed";
    }
}

function imageGenerationContent(
    item: ThreadItem & { type: "imageGeneration" }
): ToolCallContent[] {
    const content: ToolCallContent[] = [];

    if (item.revisedPrompt && item.revisedPrompt.trim() !== "") {
        content.push(createContent({
            type: "text",
            text: `Revised prompt: ${item.revisedPrompt}`,
        }));
    }

    if (item.result.trim() !== "") {
        const image: ContentBlock = item.savedPath && item.savedPath.trim() !== ""
            ? {
                type: "image",
                data: item.result,
                mimeType: "image/png",
                uri: item.savedPath,
            }
            : {
                type: "image",
                data: item.result,
                mimeType: "image/png",
            };
        content.push(createContent(image));
    }

    return content;
}

function imageGenerationRawOutput(
    item: ThreadItem & { type: "imageGeneration" }
): Record<string, string | null> {
    const output: Record<string, string | null> = {
        status: item.status,
        revisedPrompt: item.revisedPrompt,
        result: item.result,
    };
    if ("savedPath" in item) {
        output["savedPath"] = item.savedPath ?? null;
    }
    return output;
}

function createContent(content: ContentBlock): ToolCallContent {
    return {
        type: "content",
        content,
    };
}

async function createFileChangeContent(changes: FileUpdateChange[]): Promise<ToolCallContent[]> {
    const content: ToolCallContent[] = [];
    for (const change of changes) {
        content.push(...await createPatchContent(change));
    }
    return content;
}

async function createPatchContent(change: FileUpdateChange): Promise<ToolCallContent[]> {
    try {
        switch (change.kind.type) {
            case "add":
                return [createAddFileContent(change)];
            case "delete":
                return [createDeleteFileContent(change)];
            case "update":
                return createUpdateFileContent(change);
        }
    } catch (error) {
        logger.log(`Error processing file update change: ${error}`);
        return [];
    }
}

function createAddFileContent(change: FileUpdateChange): ToolCallContent {
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

function createUpdateFileContent(change: FileUpdateChange): ToolCallContent[] {
    if (change.kind.type !== "update") return [];

    const patches = parsePatch(recoverCorruptedDiff(change.diff));
    const targetPath = change.kind.move_path ?? change.path;
    return patches.flatMap((patch) => patch.hunks.map((hunk) => createUpdateDiffContent(targetPath, hunk)));
}

function createUpdateDiffContent(path: string, hunk: StructuredPatchHunk): ToolCallContent {
    return {
        type: "diff",
        oldText: createHunkText(hunk, "old"),
        newText: createHunkText(hunk, "new"),
        path,
        _meta: {
            kind: "update",
            old_start: hunk.oldStart,
            new_start: hunk.newStart,
        },
    };
}

function createHunkText(hunk: StructuredPatchHunk, side: "old" | "new"): string {
    return hunk.lines.flatMap((line): string[] => {
        switch (line[0]) {
            case " ":
                return [line.slice(1)];
            case "-":
                return side === "old" ? [line.slice(1)] : [];
            case "+":
                return side === "new" ? [line.slice(1)] : [];
            case "\\":
                return [];
            default:
                return [];
        }
    }).join("\n");
}

function createDeleteFileContent(change: FileUpdateChange): ToolCallContent {
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

function createFileChangeLocations(changes: FileUpdateChange[]): ToolCallLocation[] {
    const locations = new Map<string, ToolCallLocation>();
    const addLocation = (filePath: string, line?: number) => {
        const current = locations.get(filePath);
        if (current?.line !== undefined || (current && line === undefined)) {
            return;
        }
        locations.set(filePath, line === undefined ? { path: filePath } : { path: filePath, line });
    };

    for (const change of changes) {
        switch (change.kind.type) {
            case "add":
            case "delete":
                addLocation(change.path);
                break;
            case "update": {
                const firstHunk = firstUpdateHunk(change);
                if (change.kind.move_path && change.kind.move_path !== change.path) {
                    addLocation(change.path, firstHunk?.oldStart);
                }
                addLocation(change.kind.move_path ?? change.path, firstHunk?.newStart);
                break;
            }
        }
    }

    return [...locations.values()];
}

function firstUpdateHunk(change: FileUpdateChange): StructuredPatchHunk | undefined {
    try {
        return parsePatch(recoverCorruptedDiff(change.diff))[0]?.hunks[0];
    } catch {
        return undefined;
    }
}

function createFileChangeRawInput(changes: FileUpdateChange[]) {
    return { changes };
}

function createFileChangeRawOutput(item: FileChangeItem): Record<string, unknown> | undefined {
    if (item.status === "inProgress") {
        return undefined;
    }
    return {
        status: item.status,
        success: item.status === "completed",
    };
}

/**
 * Fix unified diff content corrupted by codex agent.
 * Removes synthetic "Moved to" from the end.
 */
function recoverCorruptedDiff(diff: string): string {
    return diff.replace(/\n\nMoved to: .*$/, "");
}
