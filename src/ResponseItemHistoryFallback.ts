import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { UpdateSessionEvent } from "./ACPSessionConnection";
import { stripShellPrefix } from "./CommandUtils";
import type { CommandAction, Thread, ThreadItem } from "./app-server/v2";
import { createCommandActionEvent } from "./CodexToolCallMapper";
import { createTerminalOutputMeta, type TerminalOutputMode } from "./TerminalOutputMode";

type JsonRecord = Record<string, unknown>;
type AcpToolCallEvent = Extract<UpdateSessionEvent, { sessionUpdate: "tool_call" }>;
type AcpToolKind = NonNullable<AcpToolCallEvent["kind"]>;
type AcpToolCallUpdateStatus = NonNullable<Extract<UpdateSessionEvent, {
    sessionUpdate: "tool_call_update"
}>["status"]>;
type LegacyFunctionCallUpdate = {
    update: AcpToolCallEvent;
    usesTerminal: boolean;
    isExecCommand: boolean;
};
type ParsedShellCommand = {
    tokens: string[];
};

function historyFallbackUpdateKey(update: UpdateSessionEvent): string | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return `${update.sessionUpdate}:${JSON.stringify(update.content)}`;
        case "tool_call":
            return `tool_call:${update.toolCallId}:start`;
        case "tool_call_update":
            return `tool_call:${update.toolCallId}:update`;
        default:
            return null;
    }
}

export async function createResponseItemHistoryFallbackUpdates(
    thread: Thread,
    terminalOutputMode: TerminalOutputMode,
): Promise<UpdateSessionEvent[] | null> {
    if (!thread.path) {
        return null;
    }

    let contents: string;
    try {
        contents = await readFile(thread.path, "utf8");
    } catch {
        return null;
    }

    return parseResponseItemHistoryFallback(contents, terminalOutputMode, toolCallIdsFromThread(thread));
}

export function parseResponseItemHistoryFallback(
    contents: string,
    terminalOutputMode: TerminalOutputMode,
    existingToolCallIds: Set<string> = new Set(),
): UpdateSessionEvent[] | null {
    const updates: UpdateSessionEvent[] = [];
    const terminalToolCallIds = new Set<string>();
    const execToolCallIds = new Set<string>();
    const skippedToolCallIds = new Set<string>();
    const emittedToolCallIds = new Set<string>();
    let recoveredFunctionCall = false;
    let lastUpdateKey: string | null = null;

    const pushUpdates = (nextUpdates: UpdateSessionEvent[]) => {
        for (const update of nextUpdates) {
            const key = historyFallbackUpdateKey(update);
            if (key && key === lastUpdateKey) {
                continue;
            }
            updates.push(update);
            lastUpdateKey = key;
        }
    };

    for (const line of contents.split(/\r?\n/)) {
        const record = parseJsonRecord(line);
        if (!record) {
            continue;
        }

        const eventMsgUpdates = createEventMsgUpdates(record);
        if (eventMsgUpdates) {
            pushUpdates(eventMsgUpdates);
            continue;
        }

        const item = extractResponseItem(record);
        if (!item) {
            continue;
        }

        switch (item["type"]) {
            case "message":
                pushUpdates(createMessageUpdates(item));
                break;
            case "reasoning":
                pushUpdates(createReasoningUpdates(item));
                break;
            case "function_call": {
                const toolCallId = stringValue(item["call_id"]);
                if (toolCallId && existingToolCallIds.has(toolCallId)) {
                    skippedToolCallIds.add(toolCallId);
                    break;
                }
                if (toolCallId && emittedToolCallIds.has(toolCallId)) {
                    break;
                }
                const result = createFunctionCallUpdate(item);
                if (!result) {
                    break;
                }
                recoveredFunctionCall = true;
                emittedToolCallIds.add(result.update.toolCallId);
                if (result.usesTerminal) {
                    terminalToolCallIds.add(result.update.toolCallId);
                }
                if (result.isExecCommand) {
                    execToolCallIds.add(result.update.toolCallId);
                }
                pushUpdates([result.update]);
                break;
            }
            case "function_call_output": {
                const toolCallId = stringValue(item["call_id"]);
                if (toolCallId && skippedToolCallIds.has(toolCallId)) {
                    break;
                }
                const update = createFunctionCallOutputUpdate(
                    item,
                    terminalOutputMode,
                    terminalToolCallIds,
                    execToolCallIds,
                );
                if (update) {
                    pushUpdates([update]);
                }
                break;
            }
            default:
                break;
        }
    }

    return recoveredFunctionCall ? updates : null;
}

function toolCallIdsFromThread(thread: Thread): Set<string> {
    const ids = new Set<string>();
    for (const turn of thread.turns) {
        for (const item of turn.items) {
            const id = toolCallIdFromThreadItem(item);
            if (id) {
                ids.add(id);
            }
        }
    }
    return ids;
}

function toolCallIdFromThreadItem(item: ThreadItem): string | null {
    switch (item.type) {
        case "commandExecution":
        case "fileChange":
        case "mcpToolCall":
        case "dynamicToolCall":
        case "collabAgentToolCall":
        case "webSearch":
        case "imageView":
        case "imageGeneration":
            return item.id;
        case "userMessage":
        case "hookPrompt":
        case "agentMessage":
        case "plan":
        case "reasoning":
        case "subAgentActivity":
        case "enteredReviewMode":
        case "exitedReviewMode":
        case "contextCompaction":
        case "sleep":
            return null;
    }
}

function parseJsonRecord(line: string): JsonRecord | null {
    if (line.trim().length === 0) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(line);
        return asRecord(value);
    } catch {
        return null;
    }
}

function extractResponseItem(record: JsonRecord): JsonRecord | null {
    if (record["type"] === "response_item") {
        return asRecord(record["payload"]);
    }
    const itemType = record["type"];
    if (typeof itemType === "string" && isLegacyResponseItemType(itemType)) {
        return record;
    }
    return null;
}

function isLegacyResponseItemType(type: string): boolean {
    switch (type) {
        case "message":
        case "reasoning":
        case "function_call":
        case "function_call_output":
            return true;
        default:
            return false;
    }
}

function createMessageUpdates(item: JsonRecord): UpdateSessionEvent[] {
    const role = item["role"];
    if (role === "user") {
        // User response items can include bootstrap context; user_message events are the visible source.
        return [];
    }
    if (role !== "assistant") {
        return [];
    }

    return contentBlocksFromResponseContent(item["content"]).map((content) => ({
        sessionUpdate: "agent_message_chunk",
        content,
    }));
}

function createEventMsgUpdates(record: JsonRecord): UpdateSessionEvent[] | null {
    if (record["type"] !== "event_msg") {
        return null;
    }

    const payload = asRecord(record["payload"]);
    if (!payload) {
        return [];
    }

    switch (payload["type"]) {
        case "user_message":
            return createUserMessageEventUpdates(payload);
        case "agent_reasoning":
            return createAgentReasoningEventUpdates(payload);
        default:
            return [];
    }
}

function createUserMessageEventUpdates(payload: JsonRecord): UpdateSessionEvent[] {
    const blocks: ContentBlock[] = [];
    const message = stringValue(payload["message"]);
    if (message !== null && message.length > 0) {
        blocks.push({ type: "text", text: message });
    }
    blocks.push(...imageBlocks(payload["images"]));
    blocks.push(...imageBlocks(payload["local_images"]));

    return blocks.map((content) => ({
        sessionUpdate: "user_message_chunk",
        content,
    }));
}

function createAgentReasoningEventUpdates(payload: JsonRecord): UpdateSessionEvent[] {
    const text = stringValue(payload["text"]);
    if (text === null || text.length === 0) {
        return [];
    }

    return [{
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
    }];
}

function imageBlocks(images: unknown): ContentBlock[] {
    if (!Array.isArray(images)) {
        return [];
    }

    return images.flatMap((image): ContentBlock[] => {
        if (typeof image === "string") {
            return [{ type: "text", text: `[@image](${image})` }];
        }

        const record = asRecord(image);
        const path = record ? stringValue(record["path"]) ?? stringValue(record["url"]) : null;
        return path ? [{ type: "text", text: `[@image](${path})` }] : [];
    });
}

function contentBlocksFromResponseContent(content: unknown): ContentBlock[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content.flatMap((entry): ContentBlock[] => {
        const record = asRecord(entry);
        if (!record) {
            return [];
        }

        const text = stringValue(record["text"]);
        if (text !== null) {
            return [{ type: "text", text }];
        }

        const imageUrl = stringValue(record["image_url"]);
        if (imageUrl !== null) {
            return [{ type: "text", text: `[@image](${imageUrl})` }];
        }

        return [];
    });
}

function createReasoningUpdates(item: JsonRecord): UpdateSessionEvent[] {
    const parts = textParts(item["summary"]);
    if (parts.length === 0) {
        parts.push(...textParts(item["content"]));
    }

    return parts.map((text) => ({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
    }));
}

function textParts(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry): string[] => {
        if (typeof entry === "string") {
            return entry.length > 0 ? [entry] : [];
        }

        const record = asRecord(entry);
        if (!record) {
            return [];
        }

        const text = stringValue(record["text"]);
        return text !== null && text.length > 0 ? [text] : [];
    });
}

function createFunctionCallUpdate(item: JsonRecord): LegacyFunctionCallUpdate | null {
    const toolCallId = stringValue(item["call_id"]);
    const name = stringValue(item["name"]);
    if (!toolCallId || !name) {
        return null;
    }

    const isExecCommand = name === "exec_command";
    const args = parseFunctionArguments(item["arguments"]);
    const command = isExecCommand ? commandFromFunctionArguments(args) : null;
    const cwd = isExecCommand ? cwdFromFunctionArguments(args) : "";
    const commandAction = command ? inferCommandAction(command, cwd) : null;
    if (commandAction) {
        return {
            update: createCommandActionEvent(toolCallId, "inProgress", cwd, commandAction),
            usesTerminal: false,
            isExecCommand,
        };
    }

    const update: AcpToolCallEvent = {
        sessionUpdate: "tool_call",
        toolCallId,
        kind: toolKindForFunctionCall(name),
        title: titleForFunctionCall(name, args),
        status: "in_progress",
        rawInput: rawInputForFunctionCall(name, args),
    };

    if (!functionCallUsesTerminal(item)) {
        return { update, usesTerminal: false, isExecCommand };
    }

    return {
        update: withTerminalContent(update, toolCallId, cwd),
        usesTerminal: true,
        isExecCommand,
    };
}

function createFunctionCallOutputUpdate(
    item: JsonRecord,
    terminalOutputMode: TerminalOutputMode,
    terminalToolCallIds: Set<string>,
    execToolCallIds: Set<string>,
): UpdateSessionEvent | null {
    const toolCallId = stringValue(item["call_id"]);
    if (!toolCallId) {
        return null;
    }

    const output = outputText(item["output"]);
    const exitCode = parseExitCode(item["output"], output);
    const status = statusFromExitCode(exitCode, output, execToolCallIds.has(toolCallId));
    if (!terminalToolCallIds.has(toolCallId)) {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status,
            rawOutput: { output: item["output"] },
        };
    }

    const meta: Record<string, unknown> = {
        terminal_exit: {
            exit_code: exitCode,
            signal: null,
            terminal_id: toolCallId,
        },
    };
    if (output.length > 0) {
        Object.assign(meta, createTerminalOutputMeta(terminalOutputMode, toolCallId, output));
    }

    return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        rawOutput: {
            formatted_output: output,
            exit_code: exitCode,
        },
        _meta: meta,
    };
}

function parseFunctionArguments(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }

    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}

function rawInputForFunctionCall(name: string, args: unknown): unknown {
    if (name === "exec_command") {
        const record = asRecord(args);
        if (record) {
            return {
                command: stringValue(record["cmd"]) ?? stringValue(record["command"]),
                cwd: stringValue(record["workdir"]) ?? stringValue(record["cwd"]),
                arguments: args,
            };
        }
    }

    return {
        name,
        arguments: args,
    };
}

function titleForFunctionCall(name: string, args: unknown): string {
    if (name === "exec_command") {
        const command = commandFromFunctionArguments(args);
        return command ? stripShellPrefix(command) : "Run command";
    }

    if (name === "apply_patch") {
        return "Apply patch";
    }

    if (name === "multi_tool_use.parallel") {
        return "Run tools in parallel";
    }

    if (name === "view_image") {
        return "View image";
    }

    return name;
}

function toolKindForFunctionCall(name: string): AcpToolKind {
    switch (name) {
        case "exec_command":
        case "multi_tool_use.parallel":
            return "execute";
        case "apply_patch":
            return "edit";
        case "view_image":
            return "read";
        default:
            return "other";
    }
}

function functionCallUsesTerminal(item: JsonRecord): boolean {
    return item["name"] === "exec_command";
}

function commandFromFunctionArguments(args: unknown): string | null {
    const record = asRecord(args);
    if (!record) {
        return null;
    }
    return stringValue(record["cmd"]) ?? stringValue(record["command"]);
}

function cwdFromFunctionArguments(args: unknown): string {
    const record = asRecord(args);
    if (!record) {
        return "";
    }
    return stringValue(record["workdir"]) ?? stringValue(record["cwd"]) ?? "";
}

function inferCommandAction(command: string, cwd: string): CommandAction | null {
    const tokens = commandTokensForClassification(command);
    if (!tokens || tokens.length === 0) {
        return null;
    }

    const commandName = baseCommandName(tokens[0] ?? "");
    switch (commandName) {
        case "ls":
        case "dir":
        case "eza":
        case "exa":
        case "tree":
        case "du":
            return {
                type: "listFiles",
                command,
                path: firstPathLikeArgument(tokens.slice(1)),
            };
        case "find":
            return {
                type: "listFiles",
                command,
                path: firstFindPath(tokens.slice(1)),
            };
        case "cat":
        case "less":
        case "more":
        case "head":
        case "tail":
        case "nl":
        case "sed": {
            const readPath = lastPathLikeArgument(tokens.slice(1));
            if (!readPath) {
                return null;
            }
            return {
                type: "read",
                command,
                name: commandName,
                path: absolutizePath(cwd, readPath),
            };
        }
        case "rg":
        case "grep":
            return inferSearchAction(command, tokens.slice(1));
        case "git":
            return inferGitAction(command, tokens.slice(1));
        default:
            return null;
    }
}

function commandTokensForClassification(command: string): string[] | null {
    const pipeline = parseShellPipeline(command);
    if (!pipeline || pipeline.length === 0) {
        return null;
    }

    if (pipeline.length === 1 && isShellInvocation(pipeline[0] ?? [])) {
        const script = pipeline[0]?.[2];
        if (!script) {
            return null;
        }
        const nestedPipeline = parseShellPipeline(script);
        return nestedPipeline ? primaryPipelineTokens(nestedPipeline) : null;
    }

    return primaryPipelineTokens(pipeline);
}

function primaryPipelineTokens(pipeline: string[][]): string[] | null {
    const primary = pipeline[0];
    if (!primary || primary.length === 0) {
        return null;
    }
    if (pipeline.length > 1 && !pipeline.slice(1).every(isSmallFormattingCommand)) {
        return null;
    }
    return primary;
}

function isShellInvocation(tokens: string[]): boolean {
    if (tokens.length < 3) {
        return false;
    }

    const commandName = baseCommandName(tokens[0] ?? "");
    if (commandName !== "bash" && commandName !== "zsh" && commandName !== "sh") {
        return false;
    }

    const flag = tokens[1];
    if (flag !== "-lc" && flag !== "-c") {
        return false;
    }

    const script = tokens[2];
    return !!script && tokens.length === 3;
}

function inferSearchAction(command: string, args: string[]): CommandAction | null {
    if (args.includes("--files")) {
        return {
            type: "listFiles",
            command,
            path: globArgument(args) ?? firstPathLikeArgument(args),
        };
    }

    const positionals = positionalArguments(args, searchOptionsWithValues());
    const query = positionals[0] ?? null;
    const searchPath = positionals[1] ?? null;
    if (query === null && searchPath === null) {
        return null;
    }

    return {
        type: "search",
        command,
        query,
        path: searchPath,
    };
}

function inferGitAction(command: string, args: string[]): CommandAction | null {
    const subcommand = args[0];
    if (subcommand === "grep") {
        const positionals = positionalArguments(args.slice(1), searchOptionsWithValues());
        const query = positionals[0] ?? null;
        const searchPath = positionals[1] ?? null;
        if (query === null && searchPath === null) {
            return null;
        }
        return {
            type: "search",
            command,
            query,
            path: searchPath,
        };
    }

    if (subcommand === "ls-files") {
        return {
            type: "listFiles",
            command,
            path: lastPathLikeArgument(args.slice(1)),
        };
    }

    return null;
}

function parseShellPipeline(command: string): string[][] | null {
    const segments: string[] = [];
    let current = "";
    let quote: "'" | "\"" | null = null;

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === undefined) {
            continue;
        }

        if (quote) {
            current += char;
            if (char === quote) {
                quote = null;
            } else if (char === "\\" && quote === "\"" && index + 1 < command.length) {
                index += 1;
                current += command[index] ?? "";
            }
            continue;
        }

        if (char === "'" || char === "\"") {
            quote = char;
            current += char;
            continue;
        }
        if (char === "\\") {
            current += char;
            index += 1;
            current += command[index] ?? "";
            continue;
        }
        if (char === "|") {
            if (current.trim().length === 0) {
                return null;
            }
            segments.push(current.trim());
            current = "";
            continue;
        }
        if (isUnsupportedShellControlChar(char)) {
            return null;
        }

        current += char;
    }

    if (quote || current.trim().length === 0) {
        return null;
    }
    segments.push(current.trim());

    const parsedSegments = segments.map(parseShellWords);
    if (parsedSegments.some((segment) => segment === null)) {
        return null;
    }
    return parsedSegments.map((segment) => segment?.tokens ?? []);
}

function parseShellWords(command: string): ParsedShellCommand | null {
    const tokens: string[] = [];
    let current = "";
    let quote: "'" | "\"" | null = null;
    let hadQuotedContent = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === undefined) {
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
                hadQuotedContent = true;
            } else if (char === "\\" && quote === "\"" && index + 1 < command.length) {
                index += 1;
                current += command[index] ?? "";
            } else {
                current += char;
            }
            continue;
        }

        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }
        if (char === "\\") {
            index += 1;
            current += command[index] ?? "";
            continue;
        }
        if (/\s/.test(char)) {
            if (current.length > 0 || hadQuotedContent) {
                tokens.push(current);
                current = "";
                hadQuotedContent = false;
            }
            continue;
        }
        if (isShellControlChar(char)) {
            return null;
        }

        current += char;
    }

    if (quote) {
        return null;
    }
    if (current.length > 0 || hadQuotedContent) {
        tokens.push(current);
    }
    return { tokens };
}

function isShellControlChar(char: string): boolean {
    return char === "|" || char === ";" || char === "&" || char === "<" || char === ">"
        || char === "(" || char === ")" || char === "$" || char === "`";
}

function isUnsupportedShellControlChar(char: string): boolean {
    return char === ";" || char === "&" || char === "<" || char === ">"
        || char === "(" || char === ")" || char === "$" || char === "`";
}

function isSmallFormattingCommand(tokens: string[]): boolean {
    const commandName = baseCommandName(tokens[0] ?? "");
    switch (commandName) {
        case "sed":
            return sedFileArguments(tokens.slice(1)).length === 0;
        case "head":
        case "tail":
            return headTailFileArguments(tokens.slice(1)).length === 0;
        case "nl":
            return positionalArguments(tokens.slice(1), genericOptionsWithValues()).length === 0;
        case "sort":
        case "uniq":
        case "wc":
        case "cut":
        case "tr":
        case "column":
            return true;
        default:
            return false;
    }
}

function positionalArguments(args: string[], optionsWithValues: Set<string>): string[] {
    const positionals: string[] = [];
    let endOfOptions = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined) {
            continue;
        }
        if (!endOfOptions && arg === "--") {
            endOfOptions = true;
            continue;
        }
        if (!endOfOptions && arg.startsWith("--") && arg.includes("=")) {
            continue;
        }
        if (!endOfOptions && optionsWithValues.has(arg)) {
            index += 1;
            continue;
        }
        if (!endOfOptions && combinedShortOptionTakesValue(arg, optionsWithValues)) {
            continue;
        }
        if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
            continue;
        }
        if (arg !== "-") {
            positionals.push(arg);
        }
    }
    return positionals;
}

function combinedShortOptionTakesValue(arg: string, optionsWithValues: Set<string>): boolean {
    if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 3) {
        return false;
    }
    return optionsWithValues.has(arg.slice(0, 2));
}

function searchOptionsWithValues(): Set<string> {
    return new Set([
        "-A",
        "-B",
        "-C",
        "-e",
        "-f",
        "-g",
        "-m",
        "-t",
        "-T",
        "--after-context",
        "--before-context",
        "--context",
        "--glob",
        "--iglob",
        "--max-count",
        "--regexp",
        "--type",
        "--type-not",
    ]);
}

function firstPathLikeArgument(args: string[]): string | null {
    return positionalArguments(args, genericOptionsWithValues())[0] ?? null;
}

function lastPathLikeArgument(args: string[]): string | null {
    const positionals = positionalArguments(args, genericOptionsWithValues());
    return positionals[positionals.length - 1] ?? null;
}

function firstFindPath(args: string[]): string | null {
    const first = args.find((arg) => arg !== undefined && !arg.startsWith("-"));
    return first ?? null;
}

function globArgument(args: string[]): string | null {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "-g" || arg === "--glob" || arg === "--iglob") {
            return args[index + 1] ?? null;
        }
        const longGlob = arg?.match(/^--(?:i?glob)=(.+)$/);
        if (longGlob?.[1]) {
            return longGlob[1];
        }
    }
    return null;
}

function genericOptionsWithValues(): Set<string> {
    return new Set([
        "-I",
        "-L",
        "-c",
        "-d",
        "-e",
        "-f",
        "-g",
        "-m",
        "-s",
        "-t",
        "-u",
        "--exclude",
        "--exclude-from",
        "--glob",
    ]);
}

function sedFileArguments(args: string[]): string[] {
    const files: string[] = [];
    let endOfOptions = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined) {
            continue;
        }
        if (!endOfOptions && arg === "--") {
            endOfOptions = true;
            continue;
        }
        if (!endOfOptions && arg === "-n") {
            continue;
        }
        if (!endOfOptions && (arg === "-e" || arg === "-f")) {
            index += 1;
            continue;
        }
        if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
            continue;
        }
        if (looksLikeSedRangeScript(arg)) {
            continue;
        }
        if (arg !== "-") {
            files.push(arg);
        }
    }
    return files;
}

function looksLikeSedRangeScript(arg: string): boolean {
    return /^(\d+|\$)?(,(\d+|\$))?[pd]$/.test(arg);
}

function headTailFileArguments(args: string[]): string[] {
    const files: string[] = [];
    let endOfOptions = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined) {
            continue;
        }
        if (!endOfOptions && arg === "--") {
            endOfOptions = true;
            continue;
        }
        if (!endOfOptions && (arg === "-n" || arg === "-c")) {
            index += 1;
            continue;
        }
        if (!endOfOptions && (arg.startsWith("-n") || arg.startsWith("-c")) && arg.length > 2) {
            continue;
        }
        if (!endOfOptions && arg.startsWith("-") && arg !== "-" && !/^[+-]\d/.test(arg)) {
            continue;
        }
        if (/^[+-]\d/.test(arg)) {
            continue;
        }
        if (arg !== "-") {
            files.push(arg);
        }
    }
    return files;
}

function baseCommandName(commandName: string): string {
    return commandName.split(/[\\/]/).pop() ?? commandName;
}

function absolutizePath(cwd: string, targetPath: string): string {
    if (path.isAbsolute(targetPath) || cwd.length === 0) {
        return targetPath;
    }
    return path.join(cwd, targetPath);
}

function withTerminalContent(
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

function outputText(output: unknown): string {
    if (typeof output === "string") {
        return output;
    }

    if (!Array.isArray(output)) {
        return "";
    }

    return output.flatMap((entry): string[] => {
        const record = asRecord(entry);
        if (!record) {
            return [];
        }

        const text = stringValue(record["text"]);
        if (text !== null) {
            return [text];
        }

        const imageUrl = stringValue(record["image_url"]);
        if (imageUrl !== null) {
            return [`[@image](${imageUrl})`];
        }

        return [];
    }).join("\n");
}

function parseExitCode(rawOutput: unknown, output: string): number | null {
    const record = asRecord(rawOutput);
    if (record) {
        const exitCode = numberValue(record["exit_code"]) ?? numberValue(record["exitCode"]);
        if (exitCode !== null) {
            return exitCode;
        }
    }

    const match = output.match(/Process exited with code (-?\d+)/);
    if (!match) {
        return null;
    }

    const exitCodeText = match[1];
    if (exitCodeText === undefined) {
        return null;
    }

    const exitCode = Number.parseInt(exitCodeText, 10);
    return Number.isFinite(exitCode) ? exitCode : null;
}

function statusFromExitCode(
    exitCode: number | null,
    output: string,
    isExecCommand: boolean,
): AcpToolCallUpdateStatus {
    if (exitCode !== null) {
        return exitCode === 0 ? "completed" : "failed";
    }

    return isExecCommand && looksLikeCommandFailure(output) ? "failed" : "completed";
}

function looksLikeCommandFailure(output: string): boolean {
    const trimmed = output.trim();
    if (trimmed.length === 0) {
        return false;
    }

    return /(^|\n)(Error|Failed|Command failed|Sandbox error|No such file or directory|Permission denied|Operation not permitted|ENOENT|EACCES)(:|\b)/i.test(trimmed);
}

function asRecord(value: unknown): JsonRecord | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as JsonRecord;
}

function stringValue(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
