import {afterEach, describe, expect, it, vi} from "vitest";
import type {Thread, ThreadItem, Turn, TurnStatus} from "../../app-server/v2";
import {connectSession, createThread, createTurn, dump, sessionId, userMessageItem, type PromptSession} from "./v2-prompt-harness";

const forkId = "fork-1";

function turn(id: string, status: TurnStatus, items: ThreadItem[]): Turn {
    return {...createTurn(status, id), itemsView: "summary", items};
}

const agentItem: ThreadItem = {type: "agentMessage", id: "agent-1", text: "Steered", phase: null, memoryCitation: null, moderation: null, delivery: null, questions: null};

const turns: Turn[] = [
    turn("turn-1", "completed", [userMessageItem("c1", "First")]),
    turn("turn-2", "completed", [userMessageItem("c2", "Second")]),
    turn("turn-steer", "completed", [agentItem]),
    turn("turn-hidden", "completed", [{type: "userMessage", id: "item-empty", clientId: "c4", content: []}]),
    turn("turn-3", "completed", [userMessageItem("c5", "Third")]),
    turn("turn-running", "inProgress", [userMessageItem("c6", "Fourth")]),
];

describe.each([1, 2] as const)("session/fork at a cursor, ACP v%s", version => {
    let client: PromptSession;
    let forkParams: unknown[];
    afterEach(() => client?.connection.close());

    async function connect() {
        client = await connectSession(version, version === 1 ? {v1ClientCapabilities: {session: {cursors: {}}}} : {});
        forkParams = [];
        client.setCodexResponse("thread/turns/list", async () => ({data: turns, nextCursor: null}));
        client.setCodexResponse("thread/fork", async params => {
            forkParams.push(params);
            const thread: Thread = createThread();
            return {
                thread: {...thread, id: forkId, sessionId: forkId},
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
            };
        });
    }

    const fork = (extra: Record<string, unknown>) => client.request("session/fork", {sessionId, cwd: "/workspace", mcpServers: [], ...extra});

    it("forks with every turn before the cursor's turn", async () => {
        await connect();

        const response = await fork({cursorId: "before:turn-3"});

        expect(response.sessionId).toBe(forkId);
        await expect(dump(forkParams)).toMatchFileSnapshot(`data/session-fork-cursor-v${version}.json`);
    });

    it.each([
        ["an unknown cursor", {cursorId: "before:turn-nope"}],
        ["a malformed cursor id", {cursorId: "turn-2"}],
        ["the cursor of the first turn", {cursorId: "before:turn-1"}],
        ["the cursor of a steer-only turn", {cursorId: "before:turn-steer"}],
        ["the cursor of a turn whose first message is hidden", {cursorId: "before:turn-hidden"}],
        ["the cursor of a turn in progress", {cursorId: "before:turn-running"}],
        ["a cursor with an AIR fork point", {
            cursorId: "before:turn-2",
            _meta: {jetbrains: {air: {fork: {version: 1, messageId: "item-user"}}}},
        }],
    ])("rejects %s", async (_name, extra) => {
        await connect();

        await expect(fork(extra)).rejects.toMatchObject({code: -32602});
        expect(forkParams).toEqual([]);
    });

    it("rejects a cursor on a subagent session", async () => {
        await connect();
        vi.spyOn(client.agent as unknown as {isRestrictedChild(id: string): boolean}, "isRestrictedChild").mockReturnValue(true);

        await expect(fork({cursorId: "before:turn-3"})).rejects.toMatchObject({code: -32602});
        expect(forkParams).toEqual([]);
    });
});
