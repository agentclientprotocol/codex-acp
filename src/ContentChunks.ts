import type {ContentBlock} from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "./ACPSessionConnection";
import {AIR_MESSAGE_PHASE_KEY, airOnlyMeta} from "./AirExtension";

type AcpMeta = Record<string, unknown>;

/** The Codex phase of an agent message. Only AIR gets it, in `_meta.jetbrains.air.phase`. */
export function createMessagePhaseMeta(phase: string | null | undefined, airClient: boolean): AcpMeta | undefined {
    if (!phase) {
        return undefined;
    }
    return airOnlyMeta(airClient, AIR_MESSAGE_PHASE_KEY, phase);
}

export function createUserMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "user_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "user_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentThoughtChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_thought_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentTextMessageChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentMessageChunk({type: "text", text}, messageId, meta);
}

export function createAgentTextThoughtChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentThoughtChunk({type: "text", text}, messageId, meta);
}
