import type {ContentBlock} from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "./ACPSessionConnection";

type AcpMeta = Record<string, unknown>;

const FILES_MENTIONED_HEADER = "# Files mentioned by the user:\n";
const REQUEST_MARKER = "\n## My request for Codex:\n";

export function visibleUserMessageText(text: string): string {
    const normalized = text.trimStart();
    const requestIndex = normalized.indexOf(REQUEST_MARKER);

    if (normalized.startsWith(FILES_MENTIONED_HEADER) && requestIndex !== -1) {
        return normalized.slice(requestIndex + REQUEST_MARKER.length);
    }

    return text;
}

export function createCodexMessagePhaseMeta(phase: string | null | undefined): AcpMeta | undefined {
    if (!phase) {
        return undefined;
    }
    return { codex: { phase } };
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
