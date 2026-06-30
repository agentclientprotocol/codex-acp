import type {ContentBlock} from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "./ACPSessionConnection";

export function createUserMessageChunk(content: ContentBlock, messageId?: string): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "user_message_chunk",
            messageId,
            content,
        };
    }
    return {
        sessionUpdate: "user_message_chunk",
        content,
    };
}

export function createAgentMessageChunk(content: ContentBlock, messageId?: string): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content,
        };
    }
    return {
        sessionUpdate: "agent_message_chunk",
        content,
    };
}

export function createAgentThoughtChunk(content: ContentBlock, messageId?: string): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content,
        };
    }
    return {
        sessionUpdate: "agent_thought_chunk",
        content,
    };
}

export function createAgentTextMessageChunk(text: string, messageId?: string): UpdateSessionEvent {
    return createAgentMessageChunk({type: "text", text}, messageId);
}

export function createAgentTextThoughtChunk(text: string, messageId?: string): UpdateSessionEvent {
    return createAgentThoughtChunk({type: "text", text}, messageId);
}
