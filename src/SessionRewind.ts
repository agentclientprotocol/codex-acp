import {createHash} from "node:crypto";
import {RequestError} from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";

export const SESSION_REWIND_METHOD = "_session/rewind";
export const SESSION_REWIND_CAPABILITY = "sessionRewind";

export type SessionHistoryPoint = {
    messageId: string;
    messageFingerprint: string;
    messageOccurrence: number;
};

export type SessionRewindRequest = {
    sessionId: string;
    beforeMessage: SessionHistoryPoint;
    resumeAtMessage?: SessionHistoryPoint;
};

export type SessionRewindResponse = {rewound: boolean};

export async function rewindSession(
    request: SessionRewindRequest,
    client: CodexAppServerClient,
): Promise<SessionRewindResponse> {
    const history = await client.threadReadWithHistory(request.sessionId);
    const userTurns = history.thread.turns.flatMap(turn => turn.items
        .filter(item => item.type === "userMessage")
        .map(item => ({turn, item})));
    const candidates = messageIdCandidates(request.beforeMessage.messageId);
    const exact = userTurns.find(({item}) => candidates.includes(item.id));
    const fingerprintMatches = userTurns.filter(({item}) =>
        fingerprint(userMessageText(item.content)) === request.beforeMessage.messageFingerprint,
    );
    const turn = exact?.turn ?? fingerprintMatches[request.beforeMessage.messageOccurrence - 1]?.turn;
    if (!turn) {
        throw RequestError.invalidParams(
            {messageId: request.beforeMessage.messageId},
            `Rewind message ${request.beforeMessage.messageId} was not found in session ${request.sessionId}`,
        );
    }
    await client.threadRevert({threadId: request.sessionId, beforeTurnId: turn.id});
    return {rewound: true};
}

function userMessageText(content: Array<{type: string; text?: string}>): string {
    return content.filter(item => item.type === "text").map(item => item.text ?? "").join("");
}

function fingerprint(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function messageIdCandidates(messageId: string): string[] {
    const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
    return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}
