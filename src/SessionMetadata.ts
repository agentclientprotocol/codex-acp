import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {ApprovalsReviewer, AskForApproval, Model, SandboxPolicy, Thread} from "./app-server/v2";

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: ServiceTier | null,
    additionalDirectories: string[],
    approvalPolicy?: AskForApproval,
    approvalsReviewer?: ApprovalsReviewer,
    sandboxPolicy?: SandboxPolicy,
}

export type SessionMetadataWithThread = SessionMetadata & {
    thread: Thread,
}
