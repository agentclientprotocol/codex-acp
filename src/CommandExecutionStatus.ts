import { stripShellPrefix } from "./CommandUtils";
import type { ThreadItem } from "./app-server/v2";

type CommandExecutionItem = ThreadItem & { type: "commandExecution" };

export function commandExecutionAcpStatus(item: CommandExecutionItem): "completed" | "failed" {
    if (item.status === "completed") {
        return "completed";
    }

    if (isRipgrepNoMatch(item)) {
        return "completed";
    }

    return "failed";
}

function isRipgrepNoMatch(item: CommandExecutionItem): boolean {
    return item.status === "failed"
        && item.exitCode === 1
        && !item.aggregatedOutput
        && item.commandActions.length === 0
        && isStandaloneRipgrepCommand(stripShellPrefix(item.command).trim());
}

function isStandaloneRipgrepCommand(command: string): boolean {
    if (!/^(?:rg|ripgrep)(?:\s|$)/.test(command)) {
        return false;
    }

    return !/[;&|`$<>\n\r]/.test(command);
}
