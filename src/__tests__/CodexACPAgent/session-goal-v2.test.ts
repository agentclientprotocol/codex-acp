import {afterEach, describe, expect, it} from 'vitest';
import {GOAL_CONTROL_METHOD} from '../../AcpExtensions';
import {
    sessionId,
    connectSession,
    turnStarted,
    turnCompleted,
    agentMessageDelta,
    settle,
    stateUpdates,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';
import type {ThreadGoal} from '../../app-server/v2';

function createThreadGoal(overrides?: Partial<ThreadGoal>): ThreadGoal {
    return {
        threadId: sessionId,
        objective: "Ship it",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function userMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "user_message_chunk");
}

function agentMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "agent_message_chunk");
}

describe('_session/goal on ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        expectConformingV2SessionUpdates();
    });

    it('sends running/idle and renders the Codex-routed turn for a v2 goal set, with no user_message, then resolves', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const goal = createThreadGoal();
        client.setCodexResponse("thread/goal/set", async () => ({goal}));
        const start = client.transcript.length;

        const goalRequest = client.request(GOAL_CONTROL_METHOD, {
            sessionId, action: "set", objective: goal.objective,
        });
        await settle();
        client.emit({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}});
        await settle();
        client.emit(turnStarted());
        await settle();
        client.emit(agentMessageDelta("Working on the goal"));
        await settle();
        client.emit(turnCompleted());

        await expect(goalRequest).resolves.toEqual({});
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(userMessageChunks(transcript)).toEqual([]);
        expect(agentMessageChunks(transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('pauses a goal and returns {}, matching v1', async () => {
        const goal = createThreadGoal({status: "paused"});
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();
            client.setCodexResponse("thread/goal/set", async () => ({goal}));

            const pauseRequest = client.request(GOAL_CONTROL_METHOD, {sessionId, action: "pause"});
            await settle();
            client.emit({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}});

            await expect(pauseRequest).resolves.toEqual({});
            client.connection.close();
            closeClient = null;
        }
    });

    it('clears a goal and returns {}, matching v1', async () => {
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();
            // `cleared: false` (already cleared) skips `runGoalClear`'s wait for a matching
            // `thread/goal/cleared` notification, which this test doesn't need to exercise.
            client.setCodexResponse("thread/goal/clear", async () => ({cleared: false}));

            await expect(client.request(GOAL_CONTROL_METHOD, {sessionId, action: "clear"})).resolves.toEqual({});
            client.connection.close();
            closeClient = null;
        }
    });

    it('rejects an unknown session with invalid_params, matching v1', async () => {
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();

            await expect(client.request(GOAL_CONTROL_METHOD, {
                sessionId: "no-such-session", action: "clear",
            })).rejects.toMatchObject({code: -32602});
            client.connection.close();
            closeClient = null;
        }
    });

    it('rejects a blank objective with invalid_params, matching v1', async () => {
        for (const protocolVersion of [1, 2] as const) {
            const client = await connectSession(protocolVersion);
            closeClient = () => client.connection.close();

            await expect(client.request(GOAL_CONTROL_METHOD, {
                sessionId, action: "set", objective: "   ",
            })).rejects.toMatchObject({code: -32602});
            client.connection.close();
            closeClient = null;
        }
    });
});
