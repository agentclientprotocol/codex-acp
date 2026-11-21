import type {CommandExecutionSource} from "./app-server/v2";

/** Matches Codex's flattened ToolName at boundaries that require a single string. */
export function functionToolName(name: string, namespace?: string | null): string {
    return `${namespace ?? ""}${name}`;
}

/** Stable ACP operation names, including sources without a Codex model-tool name. */
export function commandToolName(source: CommandExecutionSource): string {
    switch (source) {
        case "unifiedExecStartup":
        case "agent":
        case "userShell":
            return "exec_command";
        case "unifiedExecInteraction":
            return "write_stdin";
    }
}
