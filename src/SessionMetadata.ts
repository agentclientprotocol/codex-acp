import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, Thread, ThreadItemEntry, ThreadStatus} from "./app-server/v2";
import type {SessionInstructions} from "./ClientSystemPrompt";

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: ServiceTier | null,
    threadStatus?: ThreadStatus,
    additionalDirectories: string[],
    skippedMcpServers?: string[],
    instructions?: SessionInstructions,
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>,
}
