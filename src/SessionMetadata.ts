import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {
    ApprovalsReviewer,
    AskForApproval,
    Model,
    PermissionProfileSummary,
    Thread,
    ThreadItem,
} from "./app-server/v2";

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: ServiceTier | null,
    additionalDirectories: string[],
    activePermissionProfileId?: string | null,
    approvalPolicy?: AskForApproval,
    approvalsReviewer?: ApprovalsReviewer,
    permissionProfiles?: PermissionProfileSummary[],
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItem[]>,
}
