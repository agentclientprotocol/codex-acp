import type {ContentBlock, SessionMessage} from "@agentclientprotocol/sdk/unstable";
import type {ThreadItem} from "../app-server/v2";

export type SessionMessageUpdate = SessionMessage & {sessionUpdate: "session_message"};
type CollabItem = ThreadItem & {type: "collabAgentToolCall"};
type UserMessageItem = ThreadItem & {type: "userMessage"};
type View = {sessionId: string; messageId: string; text: string};

/** Collaboration tools whose prompt is a message to the receivers. */
export function sendsMessage(item: CollabItem): item is CollabItem & {prompt: string} {
    switch (item.tool) {
        case "spawnAgent":
        case "sendInput":
        case "sendMessage":
        case "followupTask":
            return item.status === "completed" && !!item.prompt;
        case "resumeAgent":
        case "wait":
        case "closeAgent":
        case "interruptAgent":
        case "listAgents":
            return false;
    }
}

/** The outgoing view's ID in the sender's transcript. A tool call can address several receivers. */
export function outgoingMessageId(item: CollabItem, receiverThreadId: string): string {
    return `${item.id}:to:${encodeURIComponent(receiverThreadId)}`;
}

export function userMessageText(item: UserMessageItem): string {
    return item.content.map(input => input.type === "text" ? input.text : "").join("");
}

/**
 * Reports each view of a message between sessions once, from the side that was observed.
 * Views are linked only when the same text was observed for the same recipient on both sides.
 */
export class SubagentMessages {
    private readonly reported = new Set<string>();
    private readonly unlinkedOutgoing = new Map<string, View[]>();
    private readonly unlinkedIncoming = new Map<string, View[]>();

    constructor(private readonly send: (update: SessionMessageUpdate, sessionId: string) => Promise<void>) {}

    async outgoing(senderSessionId: string, recipientSessionId: string, messageId: string, text: string): Promise<void> {
        if (!this.claim(senderSessionId, messageId)) return;
        const incoming = take(this.unlinkedIncoming, recipientSessionId, text);
        if (!incoming) push(this.unlinkedOutgoing, recipientSessionId, {sessionId: senderSessionId, messageId, text});
        await this.send({sessionUpdate: "session_message", messageId, senderSessionId, recipientSessionId,
            ...(incoming ? {recipientMessageId: incoming.messageId} : {}),
            content: [{type: "text", text}]}, senderSessionId);
        if (incoming) {
            await this.send({sessionUpdate: "session_message", messageId: incoming.messageId,
                senderSessionId, senderMessageId: messageId}, recipientSessionId);
        }
    }

    async incoming(recipientSessionId: string, messageId: string, text: string, content: ContentBlock[]): Promise<void> {
        if (!this.claim(recipientSessionId, messageId)) return;
        const outgoing = take(this.unlinkedOutgoing, recipientSessionId, text);
        if (!outgoing) push(this.unlinkedIncoming, recipientSessionId, {sessionId: recipientSessionId, messageId, text});
        await this.send({sessionUpdate: "session_message", messageId, recipientSessionId,
            ...(outgoing ? {senderSessionId: outgoing.sessionId, senderMessageId: outgoing.messageId} : {}),
            content}, recipientSessionId);
        if (outgoing) {
            await this.send({sessionUpdate: "session_message", messageId: outgoing.messageId,
                recipientMessageId: messageId}, outgoing.sessionId);
        }
    }

    /** A replay reports every recorded view again. */
    reset(): void {
        this.reported.clear();
        this.unlinkedOutgoing.clear();
        this.unlinkedIncoming.clear();
    }

    private claim(sessionId: string, messageId: string): boolean {
        const key = `${sessionId}\n${messageId}`;
        if (this.reported.has(key)) return false;
        this.reported.add(key);
        return true;
    }
}

function push(views: Map<string, View[]>, recipientSessionId: string, view: View): void {
    const waiting = views.get(recipientSessionId) ?? [];
    waiting.push(view);
    views.set(recipientSessionId, waiting);
}

function take(views: Map<string, View[]>, recipientSessionId: string, text: string): View | null {
    const waiting = views.get(recipientSessionId);
    const index = waiting?.findIndex(view => view.text === text) ?? -1;
    if (!waiting || index < 0) return null;
    return waiting.splice(index, 1)[0] ?? null;
}
