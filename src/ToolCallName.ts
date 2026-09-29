import type {CommandExecutionSource} from "./app-server/v2";

/** Matches Codex's flattened ToolName at boundaries that require a single string. */
export function functionToolName(name: string, namespace?: string | null): string {
    return `${namespace ?? ""}${name}`;
}

export function commandToolName(source: CommandExecutionSource): string | undefined {
    switch (source) {
        case "unifiedExecStartup":
            return "exec_command";
        case "unifiedExecInteraction":
            return "write_stdin";
        // These sources do not identify a unique model tool.
        case "agent":
        case "userShell":
            return undefined;
    }
}
