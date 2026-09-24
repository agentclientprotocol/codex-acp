import {afterEach, describe, expect, it, vi} from 'vitest';
import {SESSION_STEERING_METHOD} from '../../AcpExtensions';
import {
    sessionId,
    connectSession,
    userMessageItem,
    itemStarted,
    itemCompleted,
    turnStarted,
    turnCompleted,
    turnFinished,
    settle,
    stateUpdates,
    dump,
    type PromptSession,
    type TranscriptEntry,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function userMessageChunks(transcript: TranscriptEntry[]) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "user_message_chunk");
}

/** Overrides `turn/steer` to capture the minted `clientUserMessageId` it was sent. */
function captureSteerClientId(client: PromptSession): {captured: () => string} {
    let captured: string | null = null;
    client.setCodexResponse("turn/steer", async (params) => {
        captured = (params as {clientUserMessageId: string}).clientUserMessageId;
        return {};
    });
    return {
        captured: () => {
            if (captured === null) {
                throw new Error("turn/steer was not called yet");
            }
            return captured;
        },
    };
}

/** Runs a normal prompt to completion, so `v2PromptsInFlight` no longer owns the session. */
async function runPromptToCompletion(client: PromptSession) {
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
    await response;
    client.emit(turnCompleted());
    await client.promptRunFinished();
    await settle();
}

describe('_session/steering over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('shows a live user_message, with no extra states, when a steer injected into a v2-prompt-owned turn lands', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const steerClientId = captureSteerClientId(client);

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const promptClientId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(promptClientId)));
        const {messageId} = await response;
        const start = client.transcript.length;

        const steerResult = await client.request(SESSION_STEERING_METHOD, {
            sessionId,
            prompt: [{type: "text", text: "also do this"}],
        });
        expect(steerResult).toEqual({outcome: "injected"});
        // The response is unchanged (no messageId); the user message appears only once landed.
        expect(userMessageChunks(client.transcript.slice(start))).toEqual([]);

        client.emit(itemStarted(userMessageItem(steerClientId.captured(), "also do this")));
        await settle();
        expect(userMessageChunks(client.transcript.slice(start))).toEqual([
            {sessionUpdate: "user_message_chunk", messageId: steerClientId.captured(), content: {type: "text", text: "also do this"}},
        ]);

        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        // Steering an already-owned turn sends no states of its own.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId).replaceAll(steerClientId.captured(), "<steerMessageId>"))
            .toMatchFileSnapshot('data/steering-v2-injected-owned-turn.json');
    });

    it('shows a live user_message when a steer injected into an unowned turn lands', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);
        const steerClientId = captureSteerClientId(client);

        const start = client.transcript.length;
        client.emit(turnStarted("turn-2"));
        await settle();

        const steerResult = await client.request(SESSION_STEERING_METHOD, {
            sessionId,
            prompt: [{type: "text", text: "steer the goal turn"}],
        });
        expect(steerResult).toEqual({outcome: "injected"});

        client.emit(itemCompleted(userMessageItem(steerClientId.captured(), "steer the goal turn"), "turn-2"));
        client.emit(turnCompleted("turn-2"));
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(userMessageChunks(transcript)).toEqual([
            {sessionUpdate: "user_message_chunk", messageId: steerClientId.captured(), content: {type: "text", text: "steer the goal turn"}},
        ]);
    });

    it('emits nothing when the turn is interrupted before the steer lands', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);
        captureSteerClientId(client);

        const start = client.transcript.length;
        client.emit(turnStarted("turn-2"));
        await settle();

        const steerResult = await client.request(SESSION_STEERING_METHOD, {
            sessionId,
            prompt: [{type: "text", text: "never lands"}],
        });
        expect(steerResult).toEqual({outcome: "injected"});

        // Codex drops the steered input silently: the turn ends with no matching userMessage item.
        client.emit(turnFinished("interrupted", "turn-2"));
        await settle();

        const transcript = client.transcript.slice(start);
        expect(userMessageChunks(transcript)).toEqual([]);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "cancelled"}]);
    });

    it('starts a new turn with running/user_message/idle when there is nothing to steer', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const steerPromise = client.request(SESSION_STEERING_METHOD, {
            sessionId,
            prompt: [{type: "text", text: "start fresh"}],
        });
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        expect(clientUserMessageId).toEqual(expect.any(String));
        client.emit(turnStarted());
        const steerResult = await steerPromise;
        expect(steerResult).toEqual({outcome: "startedNewTurn"});

        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        client.emit(itemCompleted(userMessageItem(clientUserMessageId, "start fresh")));
        await settle();
        expect(userMessageChunks(client.transcript)).toEqual([
            {sessionUpdate: "user_message_chunk", messageId: clientUserMessageId, content: {type: "text", text: "start fresh"}},
        ]);

        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, clientUserMessageId)).toMatchFileSnapshot('data/steering-v2-fallback-new-turn.json');
    });

    it('queues a v2 prompt behind the steering fallback\'s new turn', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const steerPromise = client.request(SESSION_STEERING_METHOD, {
            sessionId,
            prompt: [{type: "text", text: "start fresh"}],
        });
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const steerClientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        await steerPromise;

        // A v2 prompt arriving while the fallback turn runs must queue, not start its own turn/start.
        const bResponse = client.sendPrompt([{type: "text", text: "B"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        client.emit(itemCompleted(userMessageItem(steerClientUserMessageId, "start fresh")));
        client.emit(turnCompleted());
        await client.promptRunFinished(0);
        await settle();

        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const bClientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(bClientUserMessageId, "B"), "turn-2"));
        const {messageId: bMessageId} = await bResponse;
        expect(bMessageId).toBe(bClientUserMessageId);
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
    });
});
