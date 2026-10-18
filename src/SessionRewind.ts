import {createHash} from "node:crypto";
import {RequestError} from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {userInputVisibleText} from "./UserInputContent";

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
    const userTurns = history.thread.turns.flatMap((turn, turnIndex) => turn.items
        .flatMap((item, itemIndex) => item.type === "userMessage"
            ? [{turn, turnIndex, item, itemIndex}]
            : []));
    const candidates = messageIdCandidates(request.beforeMessage.messageId);
    const exact = candidates
        .map(candidate => userTurns.find(({item}) => item.id === candidate))
        .find(match => match !== undefined);
    const match = exact ?? userTurns.filter(({item}) =>
        fingerprint(userInputVisibleText(item.content)) === request.beforeMessage.messageFingerprint,
    )[request.beforeMessage.messageOccurrence - 1];
    if (!match) {
        throw RequestError.invalidParams(
            {messageId: request.beforeMessage.messageId},
            `Rewind message ${request.beforeMessage.messageId} was not found in session ${request.sessionId}`,
        );
    }
    if (match.itemIndex !== 0) {
        throw RequestError.invalidParams(
            {messageId: request.beforeMessage.messageId},
            `Rewind message ${request.beforeMessage.messageId} does not start a turn`,
        );
    }
    // `thread/revert` replaces a paginated thread's durable history. A legacy
    // thread has no such operation at all, so the client is told the thread
    // cannot be rewound rather than being left to read a silent refusal as a
    // rewind that changed nothing.
    if (history.thread.historyMode === "legacy") {
        throw RequestError.invalidRequest(
            {sessionId: request.sessionId, historyMode: history.thread.historyMode},
            `Session ${request.sessionId} was created with legacy history, which Codex cannot rewind`,
        );
    }
    await client.threadRevert({threadId: request.sessionId, beforeTurnId: match.turn.id});
    return {rewound: true};
}

function fingerprint(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function messageIdCandidates(messageId: string): string[] {
    const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
    return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}
