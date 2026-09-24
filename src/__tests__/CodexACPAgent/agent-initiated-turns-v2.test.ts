import {afterEach, describe, expect, it, vi} from 'vitest';
import {CommandExecutionApprovalRequest} from '../../CodexAppServerClient';
import type {CommandExecutionRequestApprovalParams} from '../../app-server/v2';
import {
    sessionId,
    turnId,
    cwd,
    connectSession,
    userMessageItem,
    itemCompleted,
    turnStarted,
    turnCompleted,
    settle,
    stateUpdates,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function userMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "user_message_chunk");
}

function commandApprovalParams(overrides: Partial<CommandExecutionRequestApprovalParams> = {}): CommandExecutionRequestApprovalParams {
    return {
        kind: "command",
        threadId: sessionId,
        turnId,
        itemId: "cmd-item-1",
        startedAtMs: 0,
        environmentId: null,
        command: "ls -la",
        cwd,
        ...overrides,
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

describe('agent-initiated Codex turns over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('sends running/idle for a Codex turn that starts right after session/new, before any prompt has run', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const start = client.transcript.length;

        client.emit(turnStarted());
        await settle();
        client.emit(turnCompleted());
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(userMessageChunks(transcript)).toEqual([]);
    });

    it('sends running/idle, without a user_message, for a Codex turn that continues after a prompt\'s own idle', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        await runPromptToCompletion(client);
        // The prompt owned its own turn: exactly one running/idle pair, no duplicates.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);

        const start = client.transcript.length;
        // No `session/prompt` started this one (e.g. a `/goal` auto-continuation): the same
        // subscription that served the prompt above keeps receiving it.
        client.emit(turnStarted("turn-2"));
        await settle();
        client.emit(turnCompleted("turn-2"));
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(userMessageChunks(transcript)).toEqual([]);
    });

    it('reports `cancelled` for an unowned turn Codex reports as interrupted', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);

        const start = client.transcript.length;
        client.emit(turnStarted("turn-2"));
        await settle();
        client.emit({method: "turn/completed", params: {threadId: sessionId, turn: {
            id: "turn-2", items: [], itemsView: "notLoaded", status: "interrupted",
            error: null, startedAt: null, completedAt: null, durationMs: null,
        }}});
        await settle();

        expect(stateUpdates(client.transcript.slice(start))).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);
    });

    it('resends `running` for a permission request that settles while an unowned turn is still running', async () => {
        const client = await connectSession(2, {
            onRequestPermission: async () => ({outcome: {outcome: "selected", optionId: "allow_once"}}),
        });
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);

        const start = client.transcript.length;
        // A goal continuation (unowned) that is still running when the permission settles.
        client.emit(turnStarted("turn-2"));
        await settle();

        const response = await client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams({turnId: "turn-2"}));
        expect(response).toEqual({decision: "accept"});

        client.emit(turnCompleted("turn-2"));
        await settle();

        const transcript = client.transcript.slice(start);
        // `running` from the tracked turn start, then `requires_action`/`running` bracketing the
        // permission request (a turn is genuinely running, so `running` is not suppressed here --
        // unlike the no-turn-running case covered in permissions-v2.test.ts), then `idle`.
        expect(stateUpdates(transcript)).toEqual([
            {state: "running"},
            {state: "requires_action"},
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(userMessageChunks(transcript)).toEqual([]);
    });
});
