import type * as acp from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "../ACPSessionConnection";
import {AIR_CONTEXT_COMPACTION_KEY, withAirMeta} from "../AirExtension";
import type {ClientCapabilities} from "./ClientCapabilities";
import type {CommandEnd, PermissionToolFacts, StandardToolCallFields, ToolFacts} from "./ToolFacts";

export const AIR_SUBAGENT_KEY = "subagent";

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
            if (facts.standard?.commandEnd !== undefined) {
                const rawOutput = this.commandEndRawOutput(facts.standard.commandEnd);
                if (rawOutput !== undefined) rendered["rawOutput"] = rawOutput;
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

    private commandEndRawOutput(end: CommandEnd): unknown {
        return end.replay || !this.capabilities.terminalOutputDelta
            ? {formatted_output: end.output, exit_code: end.exitCode}
            : undefined;
    }

    /**
     * The end of a command for a client that is not AIR.
     * The output that did not stream goes to the output channel of a command that shows a terminal.
     * A live command without a terminal sends it there only when the client declares `terminal_output_delta`.
     * A replayed command without a terminal has only `rawOutput`.
     */
    private commandEndMeta(terminalId: string, end: CommandEnd): Record<string, unknown> {
        const sendOutput = end.output.length > 0 && !end.streamed
            && (end.terminal || (!end.replay && this.capabilities.terminalOutputDelta));
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
