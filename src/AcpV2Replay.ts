import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {AsyncLocalStorage} from "node:async_hooks";
import {withRequestCancellation} from "./RequestCancellation";

type Replay = {
    sessions: Set<string>;
    historical: Set<string>;
    pending: acp.UpdateSessionNotification[];
    ready: Promise<void>;
    release: () => void;
    succeeded: boolean;
};

/** Keeps live traffic out of history, including the streams of announced children. */
export class AcpV2Replay {
    private readonly replays = new Map<string, Replay>();
    private readonly history = new AsyncLocalStorage<Replay>();

    constructor(private readonly send: (params: acp.UpdateSessionNotification) => Promise<void>) {}

    async run<T>(sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.replays.has(sessionId)) throw acp.RequestError.invalidRequest(undefined, "Session replay is already in progress");
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const replay: Replay = {
            sessions: new Set([sessionId]), historical: new Set([sessionId]),
            pending: [], ready, release, succeeded: false,
        };
        this.replays.set(sessionId, replay);
        try {
            const result = await operation();
            if (signal?.aborted) throw acp.RequestError.requestCancelled(undefined, "Session replay was cancelled");
            const completed = new Set<string>();
            const complete = async (id: string) => {
                if (completed.has(id)) return;
                await this.send({sessionId: id, update: {sessionUpdate: "replay_complete"}});
                completed.add(id);
            };
            for (const id of replay.historical) await complete(id);
            // Keep queuing during the flush so a new live update cannot overtake an older one.
            for (let index = 0; index < replay.pending.length; index++) {
                const params = replay.pending[index]!;
                await this.send(params);
                // A child first discovered live is announced after the parent's boundary.
                // It still needs an empty replay boundary before its live traffic.
                if (acp.SessionUpdate.isSubagentUpdate(params.update)) await complete(params.update.sessionId);
            }
            replay.succeeded = true;
            return result;
        } finally {
            for (const id of replay.sessions) this.replays.delete(id);
            replay.release();
        }
    }

    /** Only the history reader runs in this context, never session startup or live dispatch. */
    withHistory<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
        const replay = this.replays.get(sessionId);
        return replay ? this.history.run(replay, operation) : operation();
    }

    notify(params: acp.UpdateSessionNotification): Promise<void> {
        const history = this.history.getStore();
        const replay = this.replays.get(params.sessionId);
        if (replay && acp.SessionUpdate.isSubagentUpdate(params.update)) {
            const child = params.update.sessionId;
            replay.sessions.add(child);
            this.replays.set(child, replay);
            if (history === replay && isHistoryUpdate(params.update)) replay.historical.add(child);
        }
        if (!replay || history === replay && isHistoryUpdate(params.update)) return this.send(params);
        replay.pending.push(params);
        // Producers must not block the history reader or cancellation cleanup.
        return Promise.resolve();
    }

    async wait(sessionId: string, signal?: AbortSignal): Promise<void> {
        const replay = this.replays.get(sessionId);
        if (!replay) return;
        await withRequestCancellation(replay.ready, signal);
        if (!replay.succeeded) throw acp.RequestError.requestCancelled(undefined, "Session replay did not complete");
    }
}

function isHistoryUpdate(update: acp.SessionUpdate): boolean {
    switch (update.sessionUpdate) {
        case "subagent_update":
            return acp.SessionUpdate.isSubagentUpdate(update) && update.state === undefined;
        case "state_update":
        case "config_option_update":
        case "available_commands_update":
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
    sessionUpdate: "tool_call_update" | "terminal_update" | "compaction_update";
}>;

/** Initialize retained entities once per session replay, after rendering to their v2 wire types. */
export function toV2ReplayUpdates(update: acp.SessionUpdate, initialized: Set<string>): acp.SessionUpdate[] {
    if (acp.SessionUpdate.isUserMessageChunk(update) || acp.SessionUpdate.isAgentMessageChunk(update)
        || acp.SessionUpdate.isAgentThoughtChunk(update)) {
        const kind = update.sessionUpdate === "user_message_chunk" ? "user_message"
            : update.sessionUpdate === "agent_message_chunk" ? "agent_message" : "agent_thought";
        const key = `${kind}:${update.messageId}`;
        if (initialized.has(key)) return [update];
        initialized.add(key);
        return [messageStart(kind, update.messageId), update];
    }
    if (acp.SessionUpdate.isToolCallUpdate(update) || acp.SessionUpdate.isTerminalUpdate(update)
        || acp.SessionUpdate.isCompactionUpdate(update)) {
        const id = update.sessionUpdate === "tool_call_update" ? update.toolCallId
            : update.sessionUpdate === "terminal_update" ? update.terminalId : update.compactionId;
        const key = `${update.sessionUpdate}:${id}`;
        if (initialized.has(key)) return [update];
        initialized.add(key);
        if (update._meta == null || Object.keys(update._meta).length === 0) return [{...update, _meta: null}];
        // A clear and a replacement object cannot share one metadata patch.
        return [metadataReset(update), update];
    }
    // Chunk and plan metadata, and updates outside the replayed entities, are not reset.
    return [update];
}

function messageStart(kind: "user_message" | "agent_message" | "agent_thought", messageId: string): acp.SessionUpdate {
    const fields = {messageId, content: [], _meta: null};
    switch (kind) {
        case "user_message":
            return {sessionUpdate: "user_message", ...fields};
        case "agent_message":
            return {sessionUpdate: "agent_message", ...fields};
        case "agent_thought":
            return {sessionUpdate: "agent_thought", ...fields};
    }
}

function metadataReset(update: EntityUpdate): EntityUpdate {
    switch (update.sessionUpdate) {
        case "tool_call_update":
            return {sessionUpdate: "tool_call_update", toolCallId: update.toolCallId, _meta: null};
        case "terminal_update":
            return {sessionUpdate: "terminal_update", terminalId: update.terminalId, _meta: null};
        case "compaction_update":
            return {sessionUpdate: "compaction_update", compactionId: update.compactionId, status: update.status, _meta: null};
    }
}
