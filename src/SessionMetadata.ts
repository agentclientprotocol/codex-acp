import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, Thread} from "./app-server/v2";
import type {AgentMode} from "./AgentMode";

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    agentMode?: AgentMode,
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: ServiceTier | null,
    additionalDirectories: string[],
}

export type SessionMetadataWithThread = SessionMetadata & {
    thread: Thread,
}
