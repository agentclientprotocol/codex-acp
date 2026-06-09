import type * as acp from "@agentclientprotocol/sdk";

export type TerminalOutputMode = "terminal_output" | "terminal_output_delta";

export function resolveTerminalOutputMode(
    clientCapabilities?: acp.ClientCapabilities | null
): TerminalOutputMode {
    const meta = clientCapabilities?._meta;
    if (meta?.["terminal_output"] === true) {
        return "terminal_output";
    }
    return "terminal_output_delta";
}

export function createTerminalOutputMeta(
    mode: TerminalOutputMode,
    terminalId: string,
    data: string
): Record<string, unknown> {
    switch (mode) {
        case "terminal_output":
            return {
                terminal_output: {
                    data,
                    terminal_id: terminalId,
                },
            };
        case "terminal_output_delta":
            return {
                terminal_output_delta: {
                    data,
                    terminal_id: terminalId,
                },
            };
    }
}
