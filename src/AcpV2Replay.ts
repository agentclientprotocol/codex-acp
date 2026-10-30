import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

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
