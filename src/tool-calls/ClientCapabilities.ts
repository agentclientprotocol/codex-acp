import type * as acp from "@agentclientprotocol/sdk";
import {AIR_DIFF_PATCH_KEY, clientSupportsAirCapability, isAirClient} from "../AirExtension";

export const AIR_RAW_INPUT_RENDERING_KEY = "rawInputRendering";
export const AIR_PLAN_CONTENT_DELTA_KEY = "planContentDelta";

/** The `_meta` key of a command output chunk. */
export type TerminalOutputKey = "terminal_output" | "terminal_output_delta";

/** The AIR capabilities that change the tool call and plan reports. */
export type AirCapabilities = {
    /** AIR renders `rawInput` itself, so the adapter sends no display copy of the input in `content`. */
    readonly rawInputRendering: boolean;
    /** AIR appends `plan_update._meta.jetbrains.air.contentDelta` to the plan content. */
    readonly planContentDelta: boolean;
    /** AIR reads a file change as a Git patch, see `docs/air-extensions.md#diff-patch`. */
    readonly diffPatch: boolean;
};

type ClientCapabilityValues = {
    readonly airClient: boolean;
    readonly terminalOutput: boolean;
    readonly terminalOutputDelta: boolean;
    readonly planUpdates: boolean;
    readonly air: AirCapabilities;
};

/**
 * The client capabilities that decide how the adapter reports tool calls and plans.
 * The adapter reads them once in `initialize`. See `docs/air-extensions.md#tool-call-contract`.
 *
 * Only AIR gets the reports of the tool call contract.
 * Every other client gets the reports of the adapter before the contract, see `StandardToolCallFields`.
 */
export class ClientCapabilities {
    static readonly DEFAULT = new ClientCapabilities({
        airClient: false,
        terminalOutput: false,
        terminalOutputDelta: false,
        planUpdates: false,
        air: {rawInputRendering: false, planContentDelta: false, diffPatch: false},
    });

    /** The client declares `_meta.jetbrains.air`. */
    readonly airClient: boolean;
    /** The client declares `_meta.terminal_output`, the Zed convention for command output chunks. */
    readonly terminalOutput: boolean;
    /** The client declares `_meta.terminal_output_delta` and appends the output chunks. */
    readonly terminalOutputDelta: boolean;
    /** The client shows `plan_update`. Other clients get the plan as agent message text. */
    readonly planUpdates: boolean;
    readonly air: AirCapabilities;

    private constructor(values: ClientCapabilityValues) {
        this.airClient = values.airClient;
        this.terminalOutput = values.terminalOutput;
        this.terminalOutputDelta = values.terminalOutputDelta;
        this.planUpdates = values.planUpdates;
        this.air = values.air;
    }

    static from(capabilities: acp.ClientCapabilities | null | undefined): ClientCapabilities {
        return new ClientCapabilities({
            airClient: isAirClient(capabilities),
            terminalOutput: capabilities?._meta?.["terminal_output"] === true,
            terminalOutputDelta: capabilities?._meta?.["terminal_output_delta"] === true,
            planUpdates: capabilities?.plan != null,
            air: {
                rawInputRendering: clientSupportsAirCapability(capabilities, AIR_RAW_INPUT_RENDERING_KEY),
                planContentDelta: clientSupportsAirCapability(capabilities, AIR_PLAN_CONTENT_DELTA_KEY),
                diffPatch: clientSupportsAirCapability(capabilities, AIR_DIFF_PATCH_KEY),
            },
        });
    }

    /**
     * The key of the output chunks of a command, or `null` when the client gets no chunks.
     * A client that declares `terminal_output_delta` gets appends for every command.
     * A client that declares `terminal_output` (Zed) gets `terminal_output` for a command that shows a terminal.
     * Every other client that is not AIR gets `terminal_output_delta`, as before the tool call contract.
     * AIR without either capability gets no chunks.
     */
    terminalOutputKey(terminal: boolean): TerminalOutputKey | null {
        if (this.terminalOutputDelta) return "terminal_output_delta";
        if (this.terminalOutput && terminal) return "terminal_output";
        return this.airClient ? null : "terminal_output_delta";
    }

    with(changes: Partial<Omit<ClientCapabilityValues, "air">> & {air?: Partial<AirCapabilities>}): ClientCapabilities {
        return new ClientCapabilities({
            airClient: changes.airClient ?? this.airClient,
            terminalOutput: changes.terminalOutput ?? this.terminalOutput,
            terminalOutputDelta: changes.terminalOutputDelta ?? this.terminalOutputDelta,
            planUpdates: changes.planUpdates ?? this.planUpdates,
            air: {...this.air, ...changes.air},
        });
    }
}

