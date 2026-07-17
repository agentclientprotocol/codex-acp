import type * as acp from "@agentclientprotocol/sdk";

export type TerminalOutputMode = "content" | "terminal_output" | "terminal_output_delta";

export function resolveTerminalOutputMode(
    clientCapabilities?: acp.ClientCapabilities | null
): TerminalOutputMode {
    const meta = clientCapabilities?._meta;
    if (meta?.["terminal_output"] === true) {
        return "terminal_output";
    }
    if (meta?.["terminal_output_delta"] === true) {
        return "terminal_output_delta";
    }
    return "content";
}

export function createTerminalOutputMeta(
    mode: TerminalOutputMode,
    terminalId: string,
    data: string
): Record<string, unknown> {
    switch (mode) {
        case "content":
            return {};
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
