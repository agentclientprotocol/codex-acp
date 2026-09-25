import type * as acp from "@agentclientprotocol/sdk";
import type {ContextCompactionMetadata} from "../ContextCompactionMeta";

/**
 * What a `ToolReporter` knows about one report of a tool call, before the client shape is chosen.
 *
 * Each fact has one field. `AcpToolCallRenderer` puts each fact into exactly one ACP field,
 * see `docs/air-extensions.md#tool-call-contract`. An absent field means "no news" for this report.
 */
export type ToolFacts = {
    toolCallId: string;
    /** `start` renders a `tool_call`, `update` renders a `tool_call_update`. */
    report: "start" | "update";
    /** The programmatic tool name. */
    name?: string;
    kind?: acp.ToolKind;
    title?: string;
    status?: acp.ToolCallStatus;
    /**
     * Paths of the files that the tool reads, searches or edits.
     * In a report, an empty list clears the locations. A permission request omits an empty list.
     */
    locations?: string[];
    /** The tool parameters. */
    input?: Record<string, unknown>;
    /**
     * Input that the user reads, for example a subagent prompt or a question.
     * A client without the AIR `rawInputRendering` capability gets one display copy in `content`.
     */
    readableInput?: string;
    /** The result to show. */
    result?: acp.ToolCallContent[];
    /** A result that has no display form. */
    opaqueResult?: unknown;
    /** The tool call shows a terminal. The terminal id is the tool call id. Only a `start` report sets it. */
    terminal?: {cwd: string};
    /** Command output to append to the terminal. */
    terminalOutput?: string;
    /** Text that was written to the stdin of the command. */
    terminalInput?: string;
    /** The command ended. */
    terminalExit?: {exitCode: number | null};
    mcp?: boolean;
    subagent?: boolean;
    contextCompaction?: ContextCompactionMetadata;
    /** The fields of a client that is not AIR, where they differ from the fields above. */
    standard?: StandardToolCallFields;
};

/**
 * The report fields of a client without `_meta.jetbrains.air`, where they differ from the contract fields.
 *
 * Only AIR gets the fields of `docs/air-extensions.md#tool-call-contract`.
 * Every other client keeps the fields that the adapter sent before that contract, so Zed and other ACP clients
 * see no change. A present field replaces the rendered field, and `null` removes it.
 * `AcpToolCallRenderer` applies these fields and never renders an AIR metadata key for such a client.
 */
export type StandardToolCallFields = {
    title?: string;
    kind?: acp.ToolKind;
    status?: acp.ToolCallStatus;
    locations?: string[] | null;
    content?: acp.ToolCallContent[] | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    /**
     * A chunk of command output, or the text written to the command stdin.
     * It goes to the output channel that the client declares, see `ClientCapabilities.terminalOutputKey`.
     */
    commandOutput?: {data: string; terminal: boolean};
    /** The end of a command: the output in `rawOutput.formatted_output`, the terminal output, and the exit. */
    commandEnd?: CommandEnd;
    /** MCP progress text to append in `_meta.mcp_output_delta`. AIR gets no MCP progress. */
    mcpProgress?: string;
};

export type CommandEnd = {
    /** The whole output of the command. */
    output: string;
    exitCode: number | null;
    /** The command shows a terminal. */
    terminal: boolean;
    /** Output or stdin chunks of the command came before the end. */
    streamed: boolean;
};

/**
 * The tool call of a permission request. The client merges it into the stored tool call.
 * A reporter sets only `toolCallId`, `title`, `input`, and the facts that the client does not have yet.
 */
export type PermissionToolFacts = Omit<ToolFacts, "report" | "terminal" | "terminalOutput" | "terminalInput"
    | "terminalExit" | "standard"> & {
    standard?: Omit<StandardToolCallFields, "commandOutput" | "commandEnd" | "mcpProgress">;
};
