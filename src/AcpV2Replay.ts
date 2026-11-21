import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {AsyncLocalStorage} from "node:async_hooks";
import {withRequestCancellation} from "./RequestCancellation";

type ReplaySession = {
    pending: acp.UpdateSessionNotification[];
    next: number;
    ready: Promise<boolean>;
    release: (success: boolean) => void;
    phase: "unannounced" | "awaitingAnnouncement" | "history" | "flushing" | "open";
};

type Replay = {
    sessions: Map<string, ReplaySession>;
    reading: boolean;
};

/** Keeps live traffic out of history, including the streams of announced children. */
export class AcpV2Replay {
    private readonly replays = new Map<string, Replay>();
    private readonly history = new AsyncLocalStorage<Replay>();

    constructor(private readonly send: (params: acp.UpdateSessionNotification) => Promise<void>) {}

    async run<T>(
        sessionId: string, operation: () => Promise<T>, signal?: AbortSignal,
        knownSessions: Iterable<string> = [], synchronize?: () => Promise<void>,
    ): Promise<T> {
        if (this.replays.has(sessionId)) throw acp.RequestError.invalidRequest(undefined, "Session replay is already in progress");
        const replay: Replay = {sessions: new Map(), reading: true};
        this.hold(replay, sessionId).phase = "history";
        // A live child can report before the history reader rediscovers its association.
        for (const id of knownSessions) this.hold(replay, id);
        let finished = false;
        try {
            const result = await operation();
            replay.reading = false;
            if (signal?.aborted) throw acp.RequestError.requestCancelled(undefined, "Session replay was cancelled");
            await Promise.all([...replay.sessions].filter(([, s]) => s.phase === "history").map(([id]) => this.open(replay, id)));
            await synchronize?.();
            // Previously known sessions not announced in this replay need no marker. Their
            // buffered traffic can itself announce children, whose gates must remain closed.
            for (;;) {
                const writes: Promise<void>[] = [];
                for (const session of replay.sessions.values()) {
                    if (session.phase === "unannounced" && session.next < session.pending.length) {
                        writes.push(this.sendLive(replay, session.pending[session.next++]!));
                    }
                }
                if (writes.length > 0) { await Promise.all(writes); continue; }
                const opening = [...replay.sessions].filter(([, s]) => s.phase === "awaitingAnnouncement" || s.phase === "flushing");
                if (opening.length === 0) break;
                await Promise.all(opening.map(([id]) => this.wait(id)));
            }
            finished = true;
            return result;
        } finally {
            for (const [id, session] of replay.sessions) {
                this.replays.delete(id);
                session.release(finished);
            }
        }
    }

    private hold(replay: Replay, id: string): ReplaySession {
        const existing = replay.sessions.get(id);
        if (existing) return existing;
        let release!: (success: boolean) => void;
        const ready = new Promise<boolean>(resolve => { release = resolve; });
        const session: ReplaySession = {pending: [], next: 0, ready, release, phase: "unannounced"};
        replay.sessions.set(id, session);
        this.replays.set(id, replay);
        return session;
    }

    private async open(replay: Replay, id: string): Promise<void> {
        const session = replay.sessions.get(id)!;
        if (session.phase === "flushing" || session.phase === "open") return;
        session.phase = "flushing";
        await this.send({sessionId: id, update: {sessionUpdate: "replay_complete"}});
        // Keep buffering while draining, so a live frame can't overtake an older one for this session.
        while (session.next < session.pending.length) {
            if (this.replays.get(id) !== replay) return;
            await this.sendLive(replay, session.pending[session.next++]!);
        }
        session.pending.length = 0;
        session.phase = "open";
        session.release(true);
    }

    private async sendLive(replay: Replay, params: acp.UpdateSessionNotification): Promise<void> {
        if (!acp.SessionUpdate.isSubagentUpdate(params.update)) return this.send(params);
        const child = params.update.sessionId;
        if (replay.sessions.get(child)!.phase !== "awaitingAnnouncement") return this.send(params);
        try {
            await this.send(params);
            await this.open(replay, child);
        } catch (error) {
            replay.sessions.get(child)!.release(false);
            throw error;
        }
    }

    /** Only the history reader runs in this context, never session startup or live dispatch. */
    withHistory<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
        const replay = this.replays.get(sessionId);
        return replay ? this.history.run(replay, operation) : operation();
    }

    notify(params: acp.UpdateSessionNotification): Promise<void> {
        const replay = this.replays.get(params.sessionId);
        if (!replay) return this.send(params);
        const historical = replay.reading && this.history.getStore() === replay && isHistoryUpdate(params.update);
        if (acp.SessionUpdate.isSubagentUpdate(params.update)) {
            const child = this.hold(replay, params.update.sessionId);
            if (historical) child.phase = "history";
            else if (child.phase === "unannounced") child.phase = "awaitingAnnouncement";
        }
        if (historical) return this.send(params);
        const session = replay.sessions.get(params.sessionId)!;
        if (session.phase === "open") return this.sendLive(replay, params);
        session.pending.push(params);
        // Producers must not block the history reader or cancellation cleanup.
        return Promise.resolve();
    }

    async wait(sessionId: string, signal?: AbortSignal): Promise<void> {
        const session = this.replays.get(sessionId)?.sessions.get(sessionId);
        if (session && !await withRequestCancellation(session.ready, signal)) {
            throw acp.RequestError.requestCancelled(undefined, "Session replay did not complete");
        }
    }
}

function isHistoryUpdate(update: acp.SessionUpdate): boolean {
    switch (update.sessionUpdate) {
        case "state_update":
        case "available_commands_update":
        case "config_option_update":
        case "session_info_update":
        case "usage_update":
        case "notice":
        case "prompt_suggestions_update":
            return false;
        default:
            return true;
    }
}

type EntityUpdate = Extract<acp.SessionUpdate, {
    sessionUpdate: "user_message" | "agent_message" | "agent_thought" | "session_message"
        | "tool_call_update" | "terminal_update" | "compaction_update";
}>;

export type ReplayedEntities = Map<string, {contentInitialized: boolean; compactionStatus?: acp.CompactionStatus}>;

/** Initialize retained entities once per session replay, after rendering to their v2 wire types. */
export function toV2ReplayUpdates(update: acp.SessionUpdate, entities: ReplayedEntities): acp.SessionUpdate[] {
    const primer = chunkPrimer(update);
    if (primer) {
        if (entities.get(entityKey(primer))?.contentInitialized) return [update];
        return [...toV2ReplayUpdates(primer, entities), update];
    }

    if (!acp.SessionUpdate.isUserMessage(update) && !acp.SessionUpdate.isAgentMessage(update)
        && !acp.SessionUpdate.isAgentThought(update) && !acp.SessionUpdate.isSessionMessage(update)
        && !acp.SessionUpdate.isToolCallUpdate(update) && !acp.SessionUpdate.isTerminalUpdate(update)
        && !acp.SessionUpdate.isCompactionUpdate(update)) return [update];

    const key = entityKey(update);
    const previous = entities.get(key);
    const entity = previous ?? {contentInitialized: false};
    if (!previous) entities.set(key, entity);
    const content = update.sessionUpdate === "terminal_update" ? update.output
        : update.sessionUpdate === "compaction_update" ? update.summary : update.content;
    if (content != null) entity.contentInitialized = true;

    const frames = previous ? [update] : initializeMetadata(update);
    if (update.sessionUpdate !== "compaction_update") return frames;
    // Older v2 clients require status, including on a metadata reset or summary primer.
    const {status = entity.compactionStatus} = update;
    const current = status ?? "in_progress";
    entity.compactionStatus = current;
    return frames.map(frame => ({...frame, status: current}));
}

function initializeMetadata(update: EntityUpdate): EntityUpdate[] {
    if (update._meta == null || Object.keys(update._meta).length === 0) return [{...update, _meta: null}];
    // A clear and a replacement object cannot share one metadata patch.
    return [metadataReset(update), update];
}

function chunkPrimer(update: acp.SessionUpdate): EntityUpdate | null {
    if (acp.SessionUpdate.isUserMessageChunk(update)) {
        return {sessionUpdate: "user_message", messageId: update.messageId, content: []};
    }
    if (acp.SessionUpdate.isAgentMessageChunk(update)) {
        return {sessionUpdate: "agent_message", messageId: update.messageId, content: []};
    }
    if (acp.SessionUpdate.isAgentThoughtChunk(update)) {
        return {sessionUpdate: "agent_thought", messageId: update.messageId, content: []};
    }
    if (acp.SessionUpdate.isSessionMessageChunk(update)) {
        return {sessionUpdate: "session_message", messageId: update.messageId, content: []};
    }
    if (acp.SessionUpdate.isToolCallContentChunk(update)) {
        return {sessionUpdate: "tool_call_update", toolCallId: update.toolCallId, content: []};
    }
    if (acp.SessionUpdate.isTerminalOutputChunk(update)) {
        return {sessionUpdate: "terminal_update", terminalId: update.terminalId, output: {data: ""}};
    }
    if (acp.SessionUpdate.isCompactionSummaryChunk(update)) {
        return {sessionUpdate: "compaction_update", compactionId: update.compactionId, summary: []};
    }
    return null;
}

function entityKey(update: EntityUpdate): string {
    const id = update.sessionUpdate === "tool_call_update" ? update.toolCallId
        : update.sessionUpdate === "terminal_update" ? update.terminalId
        : update.sessionUpdate === "compaction_update" ? update.compactionId : update.messageId;
    return `${update.sessionUpdate}:${id}`;
}

function metadataReset(update: EntityUpdate): EntityUpdate {
    switch (update.sessionUpdate) {
        case "tool_call_update":
            return {sessionUpdate: "tool_call_update", toolCallId: update.toolCallId, _meta: null};
        case "terminal_update":
            return {sessionUpdate: "terminal_update", terminalId: update.terminalId, _meta: null};
        case "compaction_update":
            return {sessionUpdate: "compaction_update", compactionId: update.compactionId, _meta: null};
        case "user_message":
        case "agent_message":
        case "agent_thought":
        case "session_message":
            return {sessionUpdate: update.sessionUpdate, messageId: update.messageId, _meta: null};
    }
}
