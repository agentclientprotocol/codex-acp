import {createHash} from "node:crypto";
import {RequestError} from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread, Turn} from "./app-server/v2";
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

type RewindHooks = {
    /** Called only after validation. Stops an active prompt and awaits its cleanup. */
    beforeMutation?: () => Promise<void>;
    mutationStarted?: () => void;
};

export async function rewindSession(
    request: SessionRewindRequest,
    client: CodexAppServerClient,
    hooks: RewindHooks = {},
): Promise<SessionRewindResponse> {
    const read = async () => {
        const {thread} = await client.threadReadWithHistory(request.sessionId);
        if (thread.id !== request.sessionId) throw RequestError.invalidParams(undefined, "Rewind history session changed");
        if (thread.historyMode !== "legacy" && thread.historyMode !== "paginated") {
            throw RequestError.invalidParams(undefined, "Unknown history mode; rewind requires an explicit native history mode");
        }
        return thread;
    };
    let history = await read();
    const target = resolveTarget(request, history);
    const prefix = history.turns.slice(0, target.turnIndex);
    if (hooks.beforeMutation) {
        await hooks.beforeMutation();
        // Cancellation may append the final interrupted items. Re-read the target and retained
        // prefix, rather than applying a count computed before prompt settlement.
        history = await read();
        const current = resolveTarget(request, history);
        if (current.turn.id !== target.turn.id || historyKey(history.turns.slice(0, current.turnIndex)) !== historyKey(prefix)) {
            throw RequestError.invalidParams(undefined, "Rewind history changed while settling the prompt; reload history");
        }
    }
    hooks.mutationStarted?.();
    // This choice is made from native metadata, NEVER from a caught error or a missing response field.
    if (history.historyMode === "legacy") {
        await client.threadRollback({threadId: request.sessionId, numTurns: history.turns.length - target.turnIndex});
    } else {
        await client.threadRevert({threadId: request.sessionId, beforeTurnId: target.turn.id});
    }
    // thread/revert returns turns:[] even for a nonempty prefix. Read persisted native history.
    const after = await read();
    if (historyKey(after.turns) !== historyKey(prefix)) {
        throw RequestError.internalError(undefined, "Native rewind did not retain the expected prefix; reload history before continuing");
    }
    return {rewound: true};
}

function resolveTarget(request: SessionRewindRequest, history: Thread) {
    const users = history.turns.flatMap((turn, turnIndex) => turn.items.flatMap((item, itemIndex) =>
        item.type === "userMessage" ? [{turn, turnIndex, item, itemIndex}] : []));
    const point = request.beforeMessage;
    validatePoint(point);
    const exact = messageIdCandidates(point.messageId).map(id => users.find(({item}) => item.id === id)).find(Boolean);
    const matches = () => users.filter(({item}) => fingerprint(userInputVisibleText(item.content)) === point.messageFingerprint);
    const candidates = exact ? undefined : matches();
    const match = exact ?? candidates?.[point.messageOccurrence - 1];
    if (!match) throw RequestError.invalidParams({messageId: point.messageId}, `Rewind message ${point.messageId} was not found in session ${request.sessionId}`);
    if (fingerprint(userInputVisibleText(match.item.content)) !== point.messageFingerprint) {
        throw RequestError.invalidParams(undefined, "Rewind message fingerprint changed; reload history");
    }
    if (match.itemIndex !== 0) throw RequestError.invalidParams(undefined, `Rewind message ${point.messageId} does not start a turn`);
    // Text-only fallback cannot identify content omitted by ACP replay (e.g. audio/resource links).
    if (!exact && (userInputVisibleText(match.item.content).length === 0 || match.item.content.some(input =>
        input.type === "audio" || input.type === "localAudio" || input.type === "mention" || input.type === "localImage"
        || (input.type === "text" && input.text.startsWith("# Files "))))) {
        throw RequestError.invalidParams(undefined, "Rewind attachment identity requires a current message ID; reload history");
    }
    const retained = history.turns.slice(0, match.turnIndex);
    const assistants = retained.flatMap(turn => turn.items.flatMap(item => item.type === "agentMessage" ? [item] : []));
    if (request.resumeAtMessage) {
        const anchor = request.resumeAtMessage;
        validatePoint(anchor);
        const last = assistants.at(-1);
        if (!last || fingerprint(last.text) !== anchor.messageFingerprint
            || !messageIdCandidates(anchor.messageId).includes(last.id)) {
            throw RequestError.invalidParams(undefined, "Rewind retained boundary changed; reload history");
        }
    } else if (!exact && (candidates?.length ?? 0) > 1) {
        throw RequestError.invalidParams(undefined, "Repeated rewind fingerprint requires a current retained boundary; reload history");
    }
    return match;
}

function validatePoint(point: SessionHistoryPoint): void {
    if (!point || typeof point.messageId !== "string" || !point.messageId.trim()
        || !/^sha256:[0-9a-f]{64}$/.test(point.messageFingerprint)
        || !Number.isSafeInteger(point.messageOccurrence) || point.messageOccurrence < 1) {
        throw RequestError.invalidParams(undefined, "Invalid rewind history point");
    }
}

function historyKey(turns: Turn[]): string {
    // Runtime status/timing can change during shutdown; the retained IDs and items must not.
    return JSON.stringify(turns.map(turn => [turn.id, turn.items]));
}
function fingerprint(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
function messageIdCandidates(messageId: string): string[] {
    const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
    return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}
