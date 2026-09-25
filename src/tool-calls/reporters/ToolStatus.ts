import type * as acp from "@agentclientprotocol/sdk";
import type {
    CollabAgentToolCallStatus,
    CommandExecutionStatus,
    DynamicToolCallStatus,
    McpToolCallStatus,
    PatchApplyStatus,
} from "../../app-server/v2";

type CodexItemStatus = CommandExecutionStatus | PatchApplyStatus | McpToolCallStatus | DynamicToolCallStatus
    | CollabAgentToolCallStatus;

export function toToolStatus(status: CodexItemStatus): acp.ToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "completed":
            return "completed";
        case "failed":
        case "declined":
        case "interrupted":
            return "failed";
    }
}

/** The status of a finished item. Every status other than `completed` is a failure. */
export function toTerminalToolStatus(status: CodexItemStatus): "completed" | "failed" {
    return status === "completed" ? "completed" : "failed";
}
