import {afterEach, describe, expect, it, vi} from "vitest";
import type {Thread, ThreadItem} from "../../app-server/v2";
import {
    agentMessageDelta, connectSession, createThread, createTurn, dump, itemCompleted, sessionId, settle,
    turnFinished, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import {cursorIdForTurn, turnIdOfCursor} from "../../SessionCursors";

const cursorCapabilities = {session: {cursors: {}}};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Update = {sessionUpdate: string} & Record<string, unknown>;

function updates(client: PromptSession): Update[] {
    return client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate as unknown as Update] : []);
}

/** The cursor updates, with the minted message ids replaced by numbered placeholders. */
function cursorDump(client: PromptSession): string {
    const ids = new Map<string, string>();
    const json = dump(updates(client).filter(update => update.sessionUpdate === "cursor_update"));
    return json.replace(UUID, id => {
        if (!ids.has(id)) ids.set(id, `<messageId ${ids.size + 1}>`);
        return ids.get(id)!;
    });
}

/** A prompt that Codex runs as turn `id`. On v2 the prompt is answered once Codex records its message. */
async function runTurn(client: PromptSession, version: 1 | 2, index: number, id: string, options: {output?: boolean} = {}) {
    client.setTurnStart(async () => ({turn: createTurn("inProgress", id)}));
    const response = client.sendPrompt([{type: "text", text: `Prompt ${index + 1}`}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(index + 1));
    client.emit(turnStarted(id));
    if (version === 2) {
        const clientUserMessageId = client.turnStartParams[index]!["clientUserMessageId"] as string;
        client.emit(itemCompleted(userMessageItem(clientUserMessageId, `Prompt ${index + 1}`), id));
        await response;
    }
    if (options.output ?? true) client.emit(agentMessageDelta("Reply", id, `agent-${index + 1}`));
    client.emit(turnFinished(options.output === false ? "interrupted" : "completed", id));
    await client.promptRunFinished(index);
    await response.catch(() => {});
    await settle();
}

describe("session cursors: cursor ids", () => {
    it("round-trips a turn id and rejects ids that are no cursor", () => {
        expect(turnIdOfCursor(cursorIdForTurn("turn-7"))).toBe("turn-7");
        expect(turnIdOfCursor("turn-7")).toBeNull();
        expect(turnIdOfCursor("before:")).toBeNull();
    });
});

describe.each([1, 2] as const)("session cursors, live, ACP v%s", version => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    const connect = () => connectSession(version, version === 1 ? {v1ClientCapabilities: cursorCapabilities} : {});

    it("announces the cursor before each turn but the first, and keeps the anchor of a turn without output", async () => {
        client = await connect();
        await runTurn(client, version, 0, "turn-1");
        expect(cursorDump(client)).toBe("[]\n");
        await runTurn(client, version, 1, "turn-2", {output: false});
        await runTurn(client, version, 2, "turn-3");

        await expect(cursorDump(client)).toMatchFileSnapshot(`data/session-cursors-live-v${version}.json`);
    });

    it("announces the cursor of the first prompt after a turn that Codex started itself", async () => {
        client = await connect();
        client.emit(turnStarted("goal-turn"));
        client.emit(agentMessageDelta("Goal reply", "goal-turn", "agent-goal"));
        client.emit(turnFinished("completed", "goal-turn"));
        await settle();

        await runTurn(client, version, 0, "turn-1");

        const cursors = updates(client).filter(update => update.sessionUpdate === "cursor_update");
        expect(cursors).toHaveLength(1);
        expect(cursors[0]).toMatchObject({cursorId: "before:turn-1"});
    });

    it("sends no cursor for a command turn", async () => {
        client = await connect();
        await runTurn(client, version, 0, "turn-1");

        const start = vi.fn(async () => ({turn: createTurn("inProgress", "compact-turn")}));
        client.setCodexResponse("thread/compact/start", start);
        const command = client.sendPrompt([{type: "text", text: "/compact"}]);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        if (version === 2) await command;
        client.emit(turnStarted("compact-turn"));
        client.emit(turnFinished("completed", "compact-turn"));
        await client.promptRunFinished(1);
        await command;
        await settle();

        expect(cursorDump(client)).toBe("[]\n");
    });

    it("sends no cursor for a prompt that steers a running turn", async () => {
        client = await connect();
        await runTurn(client, version, 0, "turn-1");

        // Codex already runs a turn that no prompt started: the prompt joins it as a steer.
        client.emit(turnStarted("goal-turn"));
        await settle();
        client.setTurnStart(async () => ({turn: createTurn("inProgress", "goal-turn")}));
        const steer = client.sendPrompt([{type: "text", text: "Steer"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        if (version === 2) {
            const clientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
            client.emit(itemCompleted(userMessageItem(clientUserMessageId, "Steer"), "goal-turn"));
            await steer;
        }
        client.emit(turnFinished("completed", "goal-turn"));
        await client.promptRunFinished(1);
        await steer;
        await settle();

        expect(cursorDump(client)).toBe("[]\n");
    });

    it("has no v1 anchor when the session reported no entity", async () => {
        client = await connect();
        await runTurn(client, version, 0, "turn-1", {output: false});
        await runTurn(client, version, 1, "turn-2", {output: false});

        // v1 has no entity to anchor to, v2 anchors before the user message.
        await expect(cursorDump(client)).toMatchFileSnapshot(`data/session-cursors-live-no-output-v${version}.json`);
    });
});

describe("session cursors, live, ACP v2, user message not sent", () => {
    let client: PromptSession;
    afterEach(() => {
        vi.restoreAllMocks();
        client?.connection.close();
    });

    it("announces no cursor before a message that the client does not hold", async () => {
        client = await connectSession(2);
        await runTurn(client, 2, 0, "turn-1");
        const update = ACPSessionConnection.prototype.update;
        vi.spyOn(ACPSessionConnection.prototype, "update").mockImplementation(function (this: ACPSessionConnection, event, ...rest) {
            if (event.sessionUpdate === "user_message_chunk") return Promise.reject(new Error("connection lost"));
            return update.call(this, event, ...rest);
        });

        await runTurn(client, 2, 1, "turn-2");

        expect(cursorDump(client)).toBe("[]\n");
    });
});

describe("session cursors, live, ACP v1 without the capability", () => {
    it("sends no cursor", async () => {
        const client = await connectSession(1);
        try {
            await runTurn(client, 1, 0, "turn-1");
            await runTurn(client, 1, 1, "turn-2");
            expect(cursorDump(client)).toBe("[]\n");
        } finally {
            client.connection.close();
        }
    });
});

const planImplementationClientId = "codex-acp:plan-implementation:test";

function userItem(id: string, clientId: string | null = null): ThreadItem {
    return {type: "userMessage", id, clientId, content: [{type: "text", text: `Text of ${id}`, text_elements: []}]};
}

function agentItem(id: string): ThreadItem {
    return {
        type: "agentMessage", id, text: `Text of ${id}`, phase: null, moderation: null,
        memoryCitation: null, delivery: null, questions: null,
    };
}

function turn(id: string, items: ThreadItem[]): Thread["turns"][number] {
    return {...createTurn("completed", id), itemsView: "full", items};
}

/**
 * turn-1: the first turn has no cursor. turn-2: a user message, a steer inside the turn, and a reply.
 * turn-3: its first message is hidden. turn-4: starts with a reply, no user message. turn-5: an ordinary turn.
 */
const replayTurns = [
    turn("turn-1", [userItem("u1"), agentItem("a1")]),
    turn("turn-2", [userItem("u2"), agentItem("a2"), userItem("u2-steer"), agentItem("a2-after-steer")]),
    turn("turn-3", [userItem("u3-plan", planImplementationClientId), agentItem("a3")]),
    turn("turn-4", [agentItem("a4"), userItem("u4-late")]),
    turn("turn-5", [userItem("u5"), agentItem("a5")]),
];

function replayedMessages(client: PromptSession): string {
    return dump(updates(client).filter(update => [
        "user_message_chunk", "agent_message_chunk", "cursor_update",
    ].includes(update.sessionUpdate)));
}

describe("session cursors, replay", () => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    async function load(version: 1 | 2, capabilities?: {session: {cursors: Record<string, unknown>}}) {
        client = await connectSession(version, {
            openSession: false,
            ...(version === 1 && capabilities ? {v1ClientCapabilities: capabilities} : {}),
        });
        client.setCodexResponse("thread/read", async () => ({thread: {...createThread(), turns: replayTurns}}));
        if (version === 1) await client.request("session/load", {sessionId, cwd: "/workspace", mcpServers: []});
        else await client.request("session/resume", {sessionId, cwd: "/workspace", replayFrom: {type: "start"}});
        await settle();
    }

    it.each([
        ["v1 with the capability", 1, cursorCapabilities, "v1"],
        ["v1 without the capability", 1, undefined, "v1-without-capability"],
        ["v2", 2, undefined, "v2"],
    ] as const)("announces a cursor after the first user message of a turn, %s", async (_label, version, capabilities, name) => {
        await load(version, capabilities);

        const messages = replayedMessages(client);
        await expect(messages).toMatchFileSnapshot(`data/session-cursors-replay-${name}.json`);
    });

    it.each([1, 2] as const)("announces no cursor before the first prompt of a session resumed without a replay, ACP v%s", async version => {
        client = await connectSession(version, {
            openSession: false,
            ...(version === 1 ? {v1ClientCapabilities: cursorCapabilities} : {}),
        });
        client.setCodexResponse("thread/read", async () => ({thread: {...createThread(), turns: replayTurns}}));
        await client.request("session/resume", {sessionId, cwd: "/workspace", mcpServers: []});
        await settle();

        await runTurn(client, version, 0, "turn-6");
        expect(cursorDump(client)).toBe("[]\n");

        // v1 anchors after the reply of the first prompt, v2 before the user message.
        await runTurn(client, version, 1, "turn-7");
        const cursors = updates(client).filter(update => update.sessionUpdate === "cursor_update");
        expect(cursors).toHaveLength(1);
        expect(cursors[0]).toMatchObject({cursorId: "before:turn-7"});
    });

    it("anchors the live cursor of a v1 prompt after the last replayed entity", async () => {
        await load(1, cursorCapabilities);
        await runTurn(client, 1, 0, "turn-6");

        const cursors = updates(client).filter(update => update.sessionUpdate === "cursor_update");
        expect(cursors.at(-1)).toEqual({
            sessionUpdate: "cursor_update",
            cursorId: "before:turn-6",
            capabilities: {fork: {}},
            anchor: {type: "agent_message", messageId: "a5", position: "after"},
        });
    });
});
