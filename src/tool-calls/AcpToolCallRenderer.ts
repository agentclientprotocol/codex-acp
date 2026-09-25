import type * as acp from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "../ACPSessionConnection";
import {AIR_CONTEXT_COMPACTION_KEY, AIR_SUBAGENT_KEY, withAirMeta} from "../AirExtension";
import type {ClientCapabilities} from "./ClientCapabilities";
import type {CommandEnd, PermissionToolFacts, StandardToolCallFields, ToolFacts} from "./ToolFacts";

type ToolCallReport = Extract<UpdateSessionEvent, {sessionUpdate: "tool_call" | "tool_call_update"}>;

/**
 * Turns the facts of a `ToolReporter` into ACP tool call fields.
 *
 * Each fact goes into one field, see `docs/air-extensions.md#tool-call-contract`.
 * The capabilities decide the terminal channel and the display copy of the input.
 * `ToolCallReports` then drops the fields that an earlier report already sent.
 */
export class AcpToolCallRenderer {
    constructor(readonly capabilities: ClientCapabilities) {}

    render(facts: ToolFacts): ToolCallReport {
        const rendered: Record<string, unknown> = {
            toolCallId: facts.toolCallId,
            ...(facts.name === undefined ? {} : {name: facts.name}),
            ...(facts.kind === undefined ? {} : {kind: facts.kind}),
            ...(facts.title === undefined ? {} : {title: facts.title}),
            ...(facts.status === undefined ? {} : {status: facts.status}),
            ...this.contentField(facts),
            ...(facts.locations === undefined ? {} : {locations: facts.locations.map(path => ({path}))}),
            ...(facts.input === undefined ? {} : {rawInput: facts.input}),
            ...(facts.opaqueResult === undefined ? {} : {rawOutput: facts.opaqueResult}),
        };
        const meta = this.capabilities.airClient ? this.airMeta(facts) : this.standardMeta(facts);
        if (!this.capabilities.airClient) {
            applyStandardFields(rendered, facts.standard);
            const end = facts.standard?.commandEnd;
            if (end !== undefined) {
                const rawOutput = this.commandEndRawOutput(end);
                if (rawOutput !== undefined) rendered["rawOutput"] = rawOutput;
                else delete rendered["rawOutput"];
                const content = this.commandEndContent(end);
                if (content !== undefined) rendered["content"] = content;
            }
        }
        // A `tool_call` requires a title.
        if (facts.report === "start" && rendered["title"] === undefined) rendered["title"] = "";
        const fields = {
            ...rendered,
            ...(Object.keys(meta).length > 0 ? {_meta: meta} : {}),
        } as Omit<ToolCallReport, "sessionUpdate">;
        if (facts.report === "start") {
            return {sessionUpdate: "tool_call", ...fields} as ToolCallReport;
        }
        return {sessionUpdate: "tool_call_update", ...fields};
    }

    renderPermissionToolCall(facts: PermissionToolFacts): acp.ToolCallUpdate {
        const rendered: Record<string, unknown> = {
            toolCallId: facts.toolCallId,
            ...(facts.name === undefined ? {} : {name: facts.name}),
            ...(facts.kind === undefined ? {} : {kind: facts.kind}),
            ...(facts.status === undefined ? {} : {status: facts.status}),
            ...(facts.title === undefined ? {} : {title: facts.title}),
            ...(facts.input === undefined ? {} : {rawInput: facts.input}),
            ...locationsField(facts.locations),
            ...this.contentField(facts),
        };
        if (!this.capabilities.airClient) applyStandardFields(rendered, facts.standard);
        return rendered as acp.ToolCallUpdate;
    }

    private contentField(facts: PermissionToolFacts & {terminal?: unknown}): {content?: acp.ToolCallContent[]} {
        const readableInput = facts.readableInput !== undefined && !this.capabilities.air.rawInputRendering
            ? [textContent(facts.readableInput)]
            : [];
        if (facts.terminal === undefined && readableInput.length === 0 && facts.result === undefined) {
            return {};
        }
        return {
            content: [
                ...(facts.terminal === undefined ? [] : [{type: "terminal" as const, terminalId: facts.toolCallId}]),
                ...readableInput,
                ...(facts.result ?? []),
            ],
        };
    }

    private airMeta(facts: ToolFacts): Record<string, unknown> {
        const terminalId = facts.toolCallId;
        let meta: Record<string, unknown> = {
            ...terminalInfo(facts),
            ...(facts.terminalInput === undefined ? {} : {terminal_input: {data: facts.terminalInput, terminal_id: terminalId}}),
            ...(facts.terminalOutput === undefined ? {} : this.outputChunk(terminalId, facts.terminalOutput, true)),
            ...(facts.terminalExit === undefined ? {} : terminalExit(terminalId, facts.terminalExit.exitCode)),
            ...mcpMeta(facts),
        };
        if (facts.subagent) meta = withAirMeta(meta, AIR_SUBAGENT_KEY, true);
        if (facts.contextCompaction !== undefined) {
            meta = withAirMeta(meta, AIR_CONTEXT_COMPACTION_KEY, facts.contextCompaction);
        }
        return meta;
    }

    /**
     * The metadata of a client that is not AIR. It has no AIR keys.
     * The command output comes from `facts.standard`.
     */
    private standardMeta(facts: ToolFacts): Record<string, unknown> {
        const terminalId = facts.toolCallId;
        const output = facts.standard?.commandOutput;
        const end = facts.standard?.commandEnd;
        return {
            ...terminalInfo(facts),
            ...(output === undefined ? {} : this.outputChunk(terminalId, output.data, output.terminal)),
            ...(end === undefined ? {} : this.commandEndMeta(terminalId, end)),
            ...(facts.standard?.mcpProgress === undefined ? {} : {mcp_output_delta: {data: facts.standard.mcpProgress}}),
            ...mcpMeta(facts),
        };
    }

    private outputChunk(terminalId: string, data: string, terminal: boolean): Record<string, unknown> {
        const key = this.capabilities.terminalOutputKey(terminal);
        return key === null ? {} : {[key]: {data, terminal_id: terminalId}};
    }

    /**
     * The `rawOutput` of the end of a command for a client that is not AIR: the exit code of a command without a
     * terminal. A terminal command sends its exit in `terminal_exit`. The output goes to the chunks or to `content`.
     */
    private commandEndRawOutput(end: CommandEnd): unknown {
        return end.terminal ? undefined : {exit_code: end.exitCode};
    }

    /** The whole output of a command as `content` text, for a client without a chunk channel for the command. */
    private commandEndContent(end: CommandEnd): acp.ToolCallContent[] | undefined {
        if (this.capabilities.terminalOutputKey(end.terminal) !== null || end.output.length === 0) return undefined;
        return [textContent(end.output)];
    }

    /**
     * The end of a command for a client that is not AIR.
     * The output that did not stream goes to the chunk channel once, also for a replayed command.
     */
    private commandEndMeta(terminalId: string, end: CommandEnd): Record<string, unknown> {
        const sendOutput = end.output.length > 0 && !end.streamed;
        return {
            ...(sendOutput ? this.outputChunk(terminalId, end.output, end.terminal) : {}),
            ...(end.terminal ? terminalExit(terminalId, end.exitCode) : {}),
        };
    }
}

function terminalInfo(facts: ToolFacts): Record<string, unknown> {
    return facts.terminal === undefined ? {} : {terminal_info: {cwd: facts.terminal.cwd, terminal_id: facts.toolCallId}};
}

function terminalExit(terminalId: string, exitCode: number | null): Record<string, unknown> {
    return {terminal_exit: {exit_code: exitCode, signal: null, terminal_id: terminalId}};
}

function mcpMeta(facts: ToolFacts): Record<string, unknown> {
    return facts.mcp ? {is_mcp_tool_call: true} : {};
}

/** Applies the fields of a client that is not AIR. `null` removes a field. */
function applyStandardFields(
    rendered: Record<string, unknown>,
    standard: Omit<StandardToolCallFields, "commandOutput" | "commandEnd" | "mcpProgress"> | undefined,
): void {
    if (standard === undefined) return;
    const locations = standard.locations === undefined || standard.locations === null
        ? standard.locations
        : locationsField(standard.locations).locations ?? null;
    const fields: Array<[string, unknown]> = [
        ["title", standard.title],
        ["kind", standard.kind],
        ["status", standard.status],
        ["locations", locations],
        ["content", standard.content],
        ["rawInput", standard.rawInput],
        ["rawOutput", standard.rawOutput],
    ];
    for (const [name, value] of fields) {
        if (value === undefined) continue;
        if (value === null) delete rendered[name];
        else rendered[name] = value;
    }
}

export function textContent(text: string): acp.ToolCallContent {
    return {type: "content", content: {type: "text", text}};
}

/** The locations of a permission request. An empty list sends nothing, because the request adds only new facts. */
function locationsField(paths: string[] | undefined): {locations?: acp.ToolCallLocation[]} {
    return paths === undefined || paths.length === 0 ? {} : {locations: paths.map(path => ({path}))};
}
