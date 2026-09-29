import {afterEach, describe, expect, it} from 'vitest';
import type {ServerNotification} from '../../app-server';
import type {Thread} from '../../app-server/v2';
import {
    cwd,
    codexResponse,
    connectSession,
    createThread,
    createTurn,
    settle,
    stateUpdates,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

/**
 * A second thread id, distinct from `sessionId` ("thread-1") that `connectSession` already opens
 * via `session/new`. Resuming/loading this one exercises a session that has no notification
 * handler registered yet, unlike "thread-1".
 */
const secondSessionId = "thread-2";
const secondTurnId = "turn-2a";

function turnStartedFor(threadId: string, id: string): ServerNotification {
    return {method: "turn/started", params: {threadId, turn: createTurn("inProgress", id)}};
}

function turnCompletedFor(threadId: string, id: string): ServerNotification {
    return {method: "turn/completed", params: {threadId, turn: createTurn("completed", id)}};
}

function agentMessageDeltaFor(threadId: string, turnId: string, delta: string): ServerNotification {
    return {method: "item/agentMessage/delta", params: {threadId, turnId, itemId: "goal-item-1", delta}};
}

function agentMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "agent_message_chunk");
}

/**
 * Fires a goal turn's opening notifications for `secondSessionId` from inside a Codex response
 * handler, simulating Codex auto-starting a goal turn a few ms after `thread/resume` returns --
 * before codex-acp's own post-resume setup (`model/list`, `account/read`, history reads) has
 * finished and installed the session's real notification handler.
 */
function fireGoalTurnDuring(client: PromptSession, method: string) {
    client.setCodexResponse(method, async (params) => {
        client.emit(turnStartedFor(secondSessionId, secondTurnId));
        client.emit(agentMessageDeltaFor(secondSessionId, secondTurnId, "Working on the goal"));
        return codexResponse(method);
    });
}

describe('baseline tracker installed before thread/resume, so an auto-started goal turn is not lost', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        expectConformingV2SessionUpdates();
    });

    it('v2 session/resume: renders the goal turn started during setup, no lone idle', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        fireGoalTurnDuring(client, "model/list");

        await client.request("session/resume", {sessionId: secondSessionId, cwd});
        await settle();
        client.emit(turnCompletedFor(secondSessionId, secondTurnId));
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v2 session/resume with replayFrom: start: renders the goal turn started during setup, no lone idle', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        fireGoalTurnDuring(client, "model/list");

        client.setCodexResponse("thread/read", async () => ({thread: createThread()}));
        await client.request("session/resume", {sessionId: secondSessionId, cwd, replayFrom: {type: "start"}});
        await settle();
        client.emit(turnCompletedFor(secondSessionId, secondTurnId));
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v1 session/resume: renders the goal turn started during setup', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        fireGoalTurnDuring(client, "model/list");

        await client.request("session/resume", {sessionId: secondSessionId, cwd, mcpServers: []});
        await settle();
        client.emit(turnCompletedFor(secondSessionId, secondTurnId));
        await settle();

        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v1 session/load: renders the goal turn started during setup', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/read", async () => ({thread: createThread()}));
        fireGoalTurnDuring(client, "model/list");

        await client.request("session/load", {sessionId: secondSessionId, cwd, mcpServers: []});
        await settle();
        client.emit(turnCompletedFor(secondSessionId, secondTurnId));
        await settle();

        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('v1 session/load: a live goal turn started during setup renders after replayed history, not interleaved', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();
        const replayedTurn: Thread["turns"][number] = {
            id: "replayed-turn",
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            items: [
                {
                    type: "userMessage",
                    id: "replayed-user",
                    clientId: null,
                    content: [{type: "text", text: "Earlier question", text_elements: []}],
                },
                {
                    type: "agentMessage",
                    id: "replayed-reply",
                    text: "Earlier answer",
                    phase: null,
                    memoryCitation: null,
                    delivery: null,
                    questions: null,
                },
            ],
        };
        client.setCodexResponse("thread/read", async () => ({
            thread: {...createThread(), turns: [replayedTurn]},
        }));
        fireGoalTurnDuring(client, "model/list");

        await client.request("session/load", {sessionId: secondSessionId, cwd, mcpServers: []});
        await settle();
        client.emit(turnCompletedFor(secondSessionId, secondTurnId));
        await settle();

        const replayedTexts = client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
            .filter(update => update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk")
            .map(update => (update as {content: {type: string, text?: string}}).content)
            .map(content => content.type === "text" ? content.text : null);

        // "Earlier answer" (replay) must come from the replayed turn, before "Working on the
        // goal" (the live goal turn fired during setup, via model/list).
        const replayIndex = replayedTexts.findIndex(text => text === "Earlier answer");
        const liveIndex = replayedTexts.findIndex(text => text === "Working on the goal");
        expect(replayIndex).toBeGreaterThanOrEqual(0);
        expect(liveIndex).toBeGreaterThan(replayIndex);
    });

    it('does not leak a subscription when thread/resume fails: a later resume of the same id works normally', async () => {
        const client = await connectSession(2);
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/resume", async () => {
            throw new Error("simulated thread/resume failure");
        });

        await expect(client.request("session/resume", {sessionId: secondSessionId, cwd}))
            .rejects.toThrow();

        client.setCodexResponse("thread/resume", async () => codexResponse("thread/resume"));
        await client.request("session/resume", {sessionId: secondSessionId, cwd});
        const start = client.transcript.length;

        client.emit(turnStartedFor(secondSessionId, secondTurnId));
        await settle();
        client.emit(agentMessageDeltaFor(secondSessionId, secondTurnId, "Working on the goal"));
        await settle();
        client.emit(turnCompletedFor(secondSessionId, secondTurnId));
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(agentMessageChunks(transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });
});
