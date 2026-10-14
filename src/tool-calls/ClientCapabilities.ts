import type * as acp from "@agentclientprotocol/sdk";
import {
    AIR_DIFF_PATCH_KEY,
    AIR_PLAN_CONTENT_DELTA_KEY,
    AIR_RAW_INPUT_RENDERING_KEY,
    clientSupportsAirCapability,
    isAirClient,
} from "../AirExtension";

/** The `_meta` key of a command output chunk. */
type TerminalOutputKey = "terminal_output" | "terminal_output_delta";

/**
 * How a file change diff carries a Git patch: not at all, in the AIR `diffPatch` extension,
 * or as the patch of an ACP v2 diff.
 */
export type DiffPatchFormat = "none" | "air" | "acpV2";

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
    readonly airToolCallContract: boolean;
    readonly terminalOutput: boolean;
    readonly terminalOutputDelta: boolean;
    readonly planUpdates: boolean;
    readonly air: AirCapabilities;
    readonly diffPatchFormat: DiffPatchFormat;
    readonly permissionPromptFields: boolean;
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
        airToolCallContract: false,
        terminalOutput: false,
        terminalOutputDelta: false,
        planUpdates: false,
        air: {rawInputRendering: false, planContentDelta: false, diffPatch: false},
        diffPatchFormat: "none",
        permissionPromptFields: false,
    });

    /** The client declares `_meta.jetbrains.air`. */
    readonly airClient: boolean;
    /** The client gets the tool call reports of the AIR tool call contract. Only AIR on ACP v1 does. */
    readonly airToolCallContract: boolean;
    /** The client declares `_meta.terminal_output`, the Zed convention for command output chunks. */
    readonly terminalOutput: boolean;
    /** The client declares `_meta.terminal_output_delta` and appends the output chunks. */
    readonly terminalOutputDelta: boolean;
    /** The client shows `plan_update`. Other clients get the plan as agent message text. */
    readonly planUpdates: boolean;
    readonly air: AirCapabilities;
    readonly diffPatchFormat: DiffPatchFormat;
    /** A permission request has its own `title` and `description` (ACP v2). */
    readonly permissionPromptFields: boolean;

    private constructor(values: ClientCapabilityValues) {
        this.airClient = values.airClient;
        this.airToolCallContract = values.airToolCallContract;
        this.terminalOutput = values.terminalOutput;
        this.terminalOutputDelta = values.terminalOutputDelta;
        this.planUpdates = values.planUpdates;
        this.air = values.air;
        this.diffPatchFormat = values.diffPatchFormat;
        this.permissionPromptFields = values.permissionPromptFields;
    }

    static from(capabilities: acp.ClientCapabilities | null | undefined): ClientCapabilities {
        const airClient = isAirClient(capabilities);
        const diffPatch = clientSupportsAirCapability(capabilities, AIR_DIFF_PATCH_KEY);
        return new ClientCapabilities({
            airClient,
            airToolCallContract: airClient,
            terminalOutput: capabilities?._meta?.["terminal_output"] === true,
            terminalOutputDelta: capabilities?._meta?.["terminal_output_delta"] === true,
            planUpdates: capabilities?.plan != null,
            air: {
                rawInputRendering: clientSupportsAirCapability(capabilities, AIR_RAW_INPUT_RENDERING_KEY),
                planContentDelta: clientSupportsAirCapability(capabilities, AIR_PLAN_CONTENT_DELTA_KEY),
                diffPatch,
            },
            diffPatchFormat: diffPatch ? "air" : "none",
            permissionPromptFields: false,
        });
    }

    /**
     * The capabilities of an ACP v2 client, from the v1 view of its capabilities (`toV1ClientCapabilitiesView`).
     *
     * Every v2 client gets the standard tool call reports, also AIR: v2 has its own terminal and diff updates.
     * A shell command streams its output into its terminal. A read, search or list command has no terminal,
     * so its output goes to `content` at the end. A diff carries a Git patch. A permission request has its own title.
     * Plan updates need no capability on v2.
     */
    static fromV2(capabilities: acp.ClientCapabilities | null | undefined): ClientCapabilities {
        return new ClientCapabilities({
            airClient: isAirClient(capabilities),
            airToolCallContract: false,
            terminalOutput: true,
            terminalOutputDelta: false,
            planUpdates: true,
            air: {rawInputRendering: false, planContentDelta: false, diffPatch: false},
            diffPatchFormat: "acpV2",
            permissionPromptFields: true,
        });
    }

    /**
     * The key of the output chunks of a command, or `null` when the client has no chunk channel for it.
     * A client that declares `terminal_output_delta` gets appends for every command.
     * A client that declares `terminal_output` (Zed) gets `terminal_output` for a command that shows a terminal,
     * and no chunks for a read, search or list command.
     * Every other client that is not AIR gets `terminal_output_delta`, as before the tool call contract.
     * AIR without either capability gets no chunks.
     * A command sends its output once: as chunks when the key is not `null`, and in `rawOutput` otherwise.
     */
    terminalOutputKey(terminal: boolean): TerminalOutputKey | null {
        if (this.terminalOutputDelta) return "terminal_output_delta";
        if (this.terminalOutput) return terminal ? "terminal_output" : null;
        return this.airToolCallContract ? null : "terminal_output_delta";
    }
}

