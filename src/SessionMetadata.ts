import type {ModeKind} from "./app-server/ModeKind";
import type {
    ApprovalsReviewer,
    AskForApproval,
    Model,
    PermissionProfileSummary,
    Thread,
    ThreadItemEntry,
    ThreadStatus,
} from "./app-server/v2";
import type {SessionInstructions} from "./ClientSystemPrompt";
import type {McpStartupFailure} from "./mcp/McpStartupTracker";

export type SessionOptionMetadata = {
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    currentServiceTier?: string | null,
    activePermissionProfileId?: string | null,
    approvalPolicy?: AskForApproval,
    approvalsReviewer?: ApprovalsReviewer,
    permissionProfiles?: PermissionProfileSummary[],
};

export type SessionMetadata = SessionOptionMetadata & {
    sessionId: string,
    modelProvider?: string | null,
    threadStatus?: ThreadStatus,
    additionalDirectories: string[],
    skippedMcpServers?: string[],
    mcpStartupFailures?: McpStartupFailure[],
    instructions?: SessionInstructions,
    sessionTitle?: string | null,
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>,
}
