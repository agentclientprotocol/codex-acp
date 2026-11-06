import {createHash} from "node:crypto";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {userInputVisibleText} from "./UserInputContent";

export const SESSION_REWIND_METHOD = "_session/rewind";

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
    const {thread} = await client.threadRead({threadId: request.sessionId});
    // `thread/revert` replaces only a paginated thread's history, and Codex removed
    // the deprecated `thread/rollback` that legacy history had. The client is told the
    // thread cannot be rewound rather than being left to read a silent refusal as a
    // rewind that changed nothing.
    if (thread.historyMode === "legacy") {
        throw RequestError.invalidRequest(
            {sessionId: request.sessionId, historyMode: thread.historyMode},
            `Session ${request.sessionId} was created with legacy history, which Codex cannot rewind`,
        );
    }
    const turns = await client.threadPaginatedTurns(request.sessionId);
    const userMessages = turns.flatMap(turn => turn.items.flatMap(item => item.type === "userMessage"
        ? [{turn, item}]
        : []));
    // v1 replays a message under Codex's item id, v2 under the client id it was sent with.
    const exact = messageIdCandidates(request.beforeMessage.messageId)
        .map(candidate => userMessages.find(({item}) => item.id === candidate || item.clientId === candidate))
        .find(match => match !== undefined);
    // The occurrence counts the user messages of this thread only. Subagents run in their
    // own threads, so their messages are not counted, as in the Claude adapter.
    const match = exact ?? userMessages.filter(({item}) =>
        fingerprint(userInputVisibleText(item.content)) === request.beforeMessage.messageFingerprint,
    )[request.beforeMessage.messageOccurrence - 1];
    if (!match) {
        throw RequestError.invalidParams(
            {messageId: request.beforeMessage.messageId},
            `Rewind message ${request.beforeMessage.messageId} was not found in session ${request.sessionId}`,
        );
    }
    // Codex removes whole turns, so only the message that started a turn can be the cut.
    if (match.turn.items.find(item => item.type === "userMessage") !== match.item) {
        throw RequestError.invalidParams(
            {messageId: request.beforeMessage.messageId},
            `Rewind message ${request.beforeMessage.messageId} does not start a turn`,
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
