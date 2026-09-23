import type {
    AdditionalPermissionProfile,
    CommandAction,
    CommandExecutionRequestApprovalParams,
    CommandExecutionStatus,
    ThreadItem,
} from "../../app-server/v2";
import {stripShellPrefix} from "../../CommandUtils";
import {commandToolName} from "../../ToolCallName";
import {textContent} from "../AcpToolCallRenderer";
import type {PermissionToolFacts, ToolFacts} from "../ToolFacts";
import {permissionProfileContent, permissionProfilePaths} from "./SandboxPermissionReporter";
import {toToolStatus} from "./ToolStatus";

export type CommandPermissionParams = CommandExecutionRequestApprovalParams & {
    additionalPermissions?: AdditionalPermissionProfile | null;
};

type CommandItem = ThreadItem & {type: "commandExecution"};

/**
 * Reports a Codex command execution.
 *
 * A shell command shows a terminal: its output streams into the terminal channel, and its end sends the exit code.
 * A read, search or list command has no terminal. For AIR, the output of a search or a list streams into the
 * terminal channel, and the output of a file read is not sent: the file text is not needed.
 */
export class CommandReporter {
    /** Read, search and list commands of the live turn. */
    private readonly nonTerminalCommands = new Set<string>();
    /** File read commands of the live turn. AIR gets no output of them. */
    private readonly fileReadCommands = new Set<string>();
    /** Started commands that show a terminal. */
    private readonly terminalCommands = new Set<string>();
    /** Terminal commands that already streamed output. */
    private readonly streamedCommands = new Set<string>();
    /** Commands that already sent output or stdin chunks to a client that is not AIR. */
    private readonly standardStreamedCommands = new Set<string>();

    started(item: CommandItem): ToolFacts {
        if (usesTerminal(item)) {
            this.nonTerminalCommands.delete(item.id);
            this.terminalCommands.add(item.id);
        } else {
            this.nonTerminalCommands.add(item.id);
            this.terminalCommands.delete(item.id);
        }
        if (isFileRead(item)) this.fileReadCommands.add(item.id);
        else this.fileReadCommands.delete(item.id);
        this.streamedCommands.delete(item.id);
        this.standardStreamedCommands.delete(item.id);
        return startFacts(item);
    }

    /** A chunk of command output. AIR gets no chunk of a file read. */
    outputDelta(itemId: string, delta: string): ToolFacts {
        if (delta.length > 0) this.standardStreamedCommands.add(itemId);
        const standard = {commandOutput: {data: delta, terminal: this.terminalCommands.has(itemId)}};
        if (this.fileReadCommands.has(itemId)) return {toolCallId: itemId, report: "update", standard};
        if (delta.length > 0) this.streamedCommands.add(itemId);
        return {toolCallId: itemId, report: "update", terminalOutput: delta, standard};
    }

    /**
     * Text that was written to the stdin of a running command. For AIR, it is not command output.
     * A client that is not AIR gets it as an output chunk on its own line.
     */
    terminalInput(itemId: string, stdin: string): ToolFacts {
        this.standardStreamedCommands.add(itemId);
        const standard = {commandOutput: {data: `\n${stdin}\n`, terminal: this.terminalCommands.has(itemId)}};
        if (this.nonTerminalCommands.has(itemId)) return {toolCallId: itemId, report: "update", standard};
        return {toolCallId: itemId, report: "update", terminalInput: stdin, standard};
    }

    /** Pass `withName` when the completion can be the first report of the tool call. */
    completed(item: CommandItem, withName = false): ToolFacts {
        this.nonTerminalCommands.delete(item.id);
        this.fileReadCommands.delete(item.id);
        const streamed = this.streamedCommands.delete(item.id);
        const facts = completionFacts(item, streamed, withName);
        return {
            ...facts,
            standard: {
                content: null,
                commandEnd: {
                    output: item.aggregatedOutput ?? "",
                    exitCode: item.exitCode,
                    terminal: this.terminalCommands.delete(item.id),
                    streamed: this.standardStreamedCommands.delete(item.id),
                    replay: false,
                },
            },
        };
    }

    /**
     * The tool call of an approval request. It carries the title and the parameters.
     * A started command keeps its title, kind, status and locations, so the request repeats none of them.
     * A network request and additional permissions add their own title, locations and text.
     */
    static permission(params: CommandPermissionParams, started: boolean, name?: string): PermissionToolFacts {
        const network = params.networkApprovalContext;
        const networkUrl = network?.protocol === "http" || network?.protocol === "https"
            ? `${network.protocol}://${network.host}`
            : undefined;
        const input = {
            ...(params.command ? {command: stripShellPrefix(params.command)} : {}),
            ...(params.cwd ? {cwd: params.cwd} : {}),
            ...(networkUrl ? {url: networkUrl} : {}),
            ...(params.additionalPermissions ? {additionalPermissions: params.additionalPermissions} : {}),
        };
        const actions = params.commandActions ?? [];
        const permissionContent = params.additionalPermissions
            ? permissionProfileContent(params.additionalPermissions)
            : [];
        const content = [
            ...(network ? [textContent(`${network.protocol} access to ${network.host}`)] : []),
            ...permissionContent,
        ];
        return {
            toolCallId: params.itemId,
            ...(name === undefined ? {} : {name}),
            ...(started ? {} : {kind: "execute" as const, status: "pending" as const}),
            title: network
                ? `${network.protocol} network access to ${network.host}`
                : started ? startedCommandTitle(params, actions) : permissionTitle(actions),
            ...(Object.keys(input).length > 0 ? {input} : {}),
            locations: [...new Set([
                ...(started ? [] : actionPaths(actions)),
                ...permissionProfilePaths(params.additionalPermissions),
            ])],
            ...(content.length > 0 ? {result: content} : {}),
            standard: {
                kind: "execute",
                status: "pending",
                title: network ? `${network.protocol} network access to ${network.host}` : permissionTitle(actions),
                locations: [...new Set([
                    ...actionPaths(actions),
                    ...permissionProfilePaths(params.additionalPermissions),
                ])],
            },
        };
    }

    /** The reports of a command from the thread history. */
    static history(item: CommandItem): ToolFacts[] {
        const start = startFacts(item);
        if (item.status === "inProgress") return [start];
        return [start, {
            ...completionFacts(item, false, false),
            standard: {
                content: null,
                commandEnd: {
                    output: item.aggregatedOutput ?? "",
                    exitCode: item.exitCode,
                    terminal: usesTerminal(item),
                    streamed: false,
                    replay: true,
                },
            },
        }];
    }
}

export function usesTerminal(item: CommandItem): boolean {
    const action = singleAction(item.commandActions);
    return action === undefined || action.type === "unknown";
}

function isFileRead(item: CommandItem): boolean {
    return singleAction(item.commandActions)?.type === "read";
}

function startFacts(item: CommandItem): ToolFacts {
    const name = commandToolName(item.source);
    const action = singleAction(item.commandActions);
    return {
        ...commandActionFacts(item.id, item.status, item.cwd, action ?? {type: "unknown", command: item.command}),
        ...(name === undefined ? {} : {name}),
    };
}

/** The start report of a command with one parsed action. The history fallback also uses it. */
export function commandActionFacts(
    id: string,
    status: CommandExecutionStatus,
    cwd: string,
    action: CommandAction,
): ToolFacts {
    const common = {toolCallId: id, report: "start" as const, status: toToolStatus(status)};
    switch (action.type) {
        case "read":
            return {...common, kind: "read", title: `Read file '${action.path}'`, locations: [action.path]};
        case "search":
            return {...common, kind: "search", title: searchTitle(action.query, action.path)};
        case "listFiles":
            return {...common, kind: "read", title: action.path ? `List files in '${action.path}'` : "List files"};
        case "unknown":
            return {
                ...common,
                kind: "execute",
                title: stripShellPrefix(action.command),
                input: {command: action.command, cwd},
                terminal: {cwd},
            };
    }
}

/**
 * The end of a command for AIR. Output that did not stream goes to the terminal channel once. A search or a list
 * has no exit code, and a file read has no output.
 */
function completionFacts(
    item: CommandItem,
    streamed: boolean,
    withName: boolean,
): ToolFacts {
    const name = withName ? commandToolName(item.source) : undefined;
    const output = item.aggregatedOutput ?? "";
    const facts: ToolFacts = {
        toolCallId: item.id,
        report: "update",
        ...(name === undefined ? {} : {name}),
        status: item.status === "completed" ? "completed" : "failed",
    };
    if (!usesTerminal(item)) {
        return isFileRead(item) || streamed || output.length === 0 ? facts : {...facts, terminalOutput: output};
    }
    return {
        ...facts,
        ...(!streamed && output.length > 0 ? {terminalOutput: output} : {}),
        terminalExit: {exitCode: item.exitCode},
    };
}

function singleAction(actions: CommandAction[]): CommandAction | undefined {
    return actions.length === 1 ? actions[0] : undefined;
}

export function searchTitle(query: string | null, path: string | null): string {
    if (query && path) return `Search for '${query}' in ${path}`;
    if (query) return `Search for '${query}'`;
    if (path) return `Search in '${path}'`;
    return "Search";
}

/** The title that the started tool call already shows. */
function startedCommandTitle(params: CommandPermissionParams, actions: CommandAction[]): string {
    const action = singleAction(actions) ?? (params.command ? {type: "unknown" as const, command: params.command} : undefined);
    return action === undefined
        ? "Run command"
        : commandActionFacts(params.itemId, "inProgress", params.cwd ?? "", action).title ?? "Run command";
}

function permissionTitle(actions: CommandAction[]): string {
    const first = actions[0];
    if (!first) return "Run command";
    switch (first.type) {
        case "read":
            return actions.length === 1 ? "Read file" : "Run command with file reads";
        case "listFiles":
            return "List files";
        case "search":
            return "Search files";
        case "unknown":
            return "Run command";
    }
}

function actionPaths(actions: CommandAction[]): string[] {
    return actions.flatMap(action => {
        switch (action.type) {
            case "read":
                return [action.path];
            case "listFiles":
            case "search":
                return action.path ? [action.path] : [];
            case "unknown":
                return [];
        }
    });
}
