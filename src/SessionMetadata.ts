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
import type {ResolvedPermissions} from "./AgentMode";
import type {SessionInstructions} from "./ClientSystemPrompt";

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: string | null,
    threadStatus?: ThreadStatus,
    additionalDirectories: string[],
    skippedMcpServers?: string[],
    instructions?: SessionInstructions,
    sessionTitle?: string | null,
    activePermissionProfileId?: string | null,
    /** The permissions Codex resolved for the thread; absent when its response reported none. */
    resolvedPermissions?: ResolvedPermissions,
    approvalPolicy?: AskForApproval,
    approvalsReviewer?: ApprovalsReviewer,
    permissionProfiles?: PermissionProfileSummary[],
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>,
}
