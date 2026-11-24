import type {ClientCapabilities} from "@agentclientprotocol/sdk/unstable";
import type {UpdateSessionEvent} from "./ACPSessionConnection";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {ThreadItem} from "./app-server/v2";

/**
 * Session cursors (the unstable session cursors RFD): the positions of a session that a method
 * can act at.
 *
 * The adapter announces one kind: the position before the first user message of a turn, with the
 * `fork` capability. Codex cuts whole turns, so the position is a turn boundary, and a steer (a
 * user message inside a turn) has none. The first turn of a session has no cursor either:
 * nothing is before it.
 *
 * The `cursorId` is derived from the turn id, which Codex stores. So it is the same live, in
 * every replay and after a restart, and the adapter keeps no cursors of its own.
 */

/** What the cursor ids start with. The rest is the id of the turn that the cursor lies before. */
const BEFORE_TURN = "before:";

export type CursorUpdate = Extract<UpdateSessionEvent, {sessionUpdate: "cursor_update"}>;

/** The entity that a cursor is anchored to. */
export type CursorEntity =
    | {type: "user_message" | "agent_message" | "agent_thought"; messageId: string}
    | {type: "tool_call"; toolCallId: string}
    | {type: "compaction"; compactionId: string};

/** The side of its {@link CursorEntity} that a cursor lies on. */
export type CursorAnchor = CursorEntity & {position: "before" | "after"};

export function cursorIdForTurn(turnId: string): string {
    return `${BEFORE_TURN}${turnId}`;
}

/** The id of the turn that `cursorId` lies before, or `null` for an id that is no cursor. */
export function turnIdOfCursor(cursorId: string): string | null {
    return cursorId.startsWith(BEFORE_TURN) && cursorId.length > BEFORE_TURN.length
        ? cursorId.slice(BEFORE_TURN.length)
        : null;
}

/** v1 clients opt in with `session.cursors`. The v2 view of the capabilities always has it. */
export function clientSupportsCursors(capabilities?: ClientCapabilities | null): boolean {
    const cursors = capabilities?.session?.cursors;
    return typeof cursors === "object" && cursors !== null && !Array.isArray(cursors);
}

/** `update` with the `rewind` capability added: the cursor is also a position that `_session/rewind` accepts. */
export function withRewindCapability(update: CursorUpdate): CursorUpdate {
    return {...update, capabilities: {...update.capabilities, rewind: {}} as NonNullable<CursorUpdate["capabilities"]>};
}

/** The cursor before the turn `turnId`, placed by `anchor`. */
export function forkCursorUpdate(turnId: string, anchor: CursorAnchor): CursorUpdate {
    return {
        sessionUpdate: "cursor_update",
        cursorId: cursorIdForTurn(turnId),
        capabilities: {fork: {}},
        anchor,
    };
}

/** The cursor before the turn `turnId`, placed before the user message `messageId` that starts it. */
export function beforeUserMessageCursorUpdate(turnId: string, messageId: string): CursorUpdate {
    return forkCursorUpdate(turnId, {type: "user_message", messageId, position: "before"});
}

/**
 * The last entity per session that a client can anchor a cursor to: an agent message or thought
 * or a user message with a `messageId`, a tool call or a compaction. v1 does not report the
 * prompt that the client sent, so a live cursor lies `after` the entity before it. Each session
 * update that goes to the client passes through {@link sending}, a replay too.
 */
export class LastReportedEntity {
    private readonly bySession = new Map<string, CursorEntity>();
    /** Per session, in announcement order: the entity that the client held right before each announced cursor. */
    private readonly beforeCursor = new Map<string, Map<string, CursorEntity | undefined>>();

    sending(sessionId: string, update: UpdateSessionEvent): void {
        switch (update.sessionUpdate) {
            case "user_message_chunk":
                if (update.messageId) this.bySession.set(sessionId, {type: "user_message", messageId: update.messageId});
                break;
            case "agent_message_chunk":
                if (update.messageId) this.bySession.set(sessionId, {type: "agent_message", messageId: update.messageId});
                break;
            case "agent_thought_chunk":
                if (update.messageId) this.bySession.set(sessionId, {type: "agent_thought", messageId: update.messageId});
                break;
            case "tool_call":
                this.bySession.set(sessionId, {type: "tool_call", toolCallId: update.toolCallId});
                break;
            case "compaction_update":
                this.bySession.set(sessionId, {type: "compaction", compactionId: update.compactionId});
                break;
            case "plan":
            case "available_commands_update":
            case "current_mode_update":
            case "config_option_update":
            case "session_info_update":
            case "usage_update":
            case "cursor_update":
            case "tool_call_update":
            case "subagent_spawned":
            case "subagent_state_update":
            case "subagent_update":
            case "async_task_progress":
            case "async_task_spawned":
            case "async_task_state_update":
            case "compaction_summary_chunk":
            case "session_message_chunk":
            case "notice":
            case "plan_removed":
            case "plan_update":
            case "prompt_suggestions_update":
            case "session_message":
                break;
        }
    }

    /** The position after the last entity of the session, or `null` if the client holds none. */
    after(sessionId: string): CursorAnchor | null {
        const entity = this.bySession.get(sessionId);
        return entity ? {...entity, position: "after"} : null;
    }

    /** The last entity of the session that the client holds, if any. */
    last(sessionId: string): CursorEntity | undefined {
        return this.bySession.get(sessionId);
    }

    /** The adapter announces `cursorId`; `before` is the entity that the client holds right before it. */
    recordCursor(sessionId: string, cursorId: string, before: CursorEntity | undefined): void {
        let records = this.beforeCursor.get(sessionId);
        if (!records) this.beforeCursor.set(sessionId, records = new Map());
        records.set(cursorId, before);
    }

    /**
     * The session is rewound to `cursorId`: the client drops the entities from there on, so the entity
     * recorded for the cursor is its last one (none for a cursor without a record: the next prompt then
     * gets no cursor). The records of the cursors at and after the cut go too.
     */
    rewind(sessionId: string, cursorId: string): void {
        const records = this.beforeCursor.get(sessionId);
        const before = records?.get(cursorId);
        if (before) this.bySession.set(sessionId, before);
        else this.bySession.delete(sessionId);
        if (!records?.has(cursorId)) return;
        let cut = false;
        for (const id of [...records.keys()]) {
            cut ||= id === cursorId;
            if (cut) records.delete(id);
        }
    }

    /** The client no longer holds the session's entities: it closed, or a replay rebuilds them. */
    forget(sessionId: string): void {
        for (const map of [this.bySession, this.beforeCursor]) {
            for (const id of map.keys()) {
                if (id === sessionId || id.startsWith(`${sessionId}:`)) map.delete(id);
            }
        }
    }
}

/**
 * Finds, while a history streams, the cursor of each turn: the one before its first user message.
 * The generators that read the history call {@link observe} for each entry in order, and the
 * replay asks {@link cursorAfter} for each item it has sent.
 */
export class ReplayCursors {
    private turnId: string | null = null;
    /** The first item of each turn after the first one. */
    private readonly turnStarts = new WeakMap<ThreadItem, string>();

    observe(turnId: string, item: ThreadItem): void {
        if (turnId === this.turnId) return;
        if (this.turnId !== null) this.turnStarts.set(item, turnId);
        this.turnId = turnId;
    }

    /**
     * The cursor update to send after the replayed `updates` of `item`, or `null` if `item` has none.
     * A first user message that the client does not see (hidden, or shown as something else) has none.
     */
    cursorAfter(item: ThreadItem, updates: readonly UpdateSessionEvent[]): CursorUpdate | null {
        const turnId = this.turnStarts.get(item);
        return turnId === undefined ? null : turnStartCursor(turnId, item, updates);
    }
}

/**
 * The cursor before the turn `turnId`, given its first item and the `updates` that the item replays
 * as, or `null` if the client has none. A first user message that the client does not see (hidden,
 * or shown as something else) has none.
 */
function turnStartCursor(turnId: string, firstItem: ThreadItem, updates: readonly UpdateSessionEvent[]): CursorUpdate | null {
    if (firstItem.type !== "userMessage") return null;
    for (const update of [...updates].reverse()) {
        if (update.sessionUpdate !== "user_message_chunk") continue;
        return update.messageId ? beforeUserMessageCursorUpdate(turnId, update.messageId) : null;
    }
    return null;
}

/** The turn that a cursor lies before, and the turn that precedes it: the last one that stays. */
export type CursorTurn = {turnId: string; previousTurnId: string};

/**
 * The turn of `cursorId` in the thread `threadId`, for a method that acts at a cursor. The cursor
 * must be one that the adapter announces: see {@link ReplayCursors}. `historyUpdates` gives the
 * updates that a replay sends for an item. Throws invalid params, saying what to do, otherwise.
 */
export async function resolveCursorTurn(
    cursorId: string,
    threadId: string,
    codexClient: Pick<CodexAppServerClient, "threadTurnPages">,
    historyUpdates: (item: ThreadItem) => Promise<UpdateSessionEvent[]>,
): Promise<CursorTurn> {
    const turnId = turnIdOfCursor(cursorId);
    if (turnId === null) {
        throw RequestError.invalidParams({cursorId}, `"${cursorId}" is not a session cursor. Use a cursorId from a cursor_update of the session`);
    }
    let previous: {id: string; status: string} | null = null;
    // "summary" holds the first user message of a turn, which is all that a cursor needs.
    for await (const page of codexClient.threadTurnPages({threadId, limit: 100, sortDirection: "asc", itemsView: "summary"})) {
        for (const turn of page) {
            if (turn.id !== turnId) {
                previous = turn;
                continue;
            }
            if (previous === null) {
                throw RequestError.invalidParams({cursorId}, `Cursor ${cursorId} lies before the first turn, so nothing is before it. Use a cursor of a later turn`);
            }
            if (turn.status === "inProgress" || previous.status === "inProgress") {
                throw RequestError.invalidParams({cursorId}, `The turn of cursor ${cursorId} or the one before it is still running. Cancel it or wait until it ends`);
            }
            const first = turn.items[0];
            if (first === undefined || turnStartCursor(turnId, first, await historyUpdates(first)) === null) {
                throw RequestError.invalidParams({cursorId}, `Cursor ${cursorId} is not one that the session announced: its turn does not start with a visible user message. Use a cursorId from a cursor_update of the session`);
            }
            return {turnId, previousTurnId: previous.id};
        }
    }
    throw RequestError.invalidParams({cursorId}, `Cursor ${cursorId} is not in session ${threadId}. Use a cursorId from a cursor_update of the session`);
}
