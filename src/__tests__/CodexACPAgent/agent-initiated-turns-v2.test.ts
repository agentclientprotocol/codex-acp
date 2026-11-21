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
    agentMessageDelta,
    settle,
    stateUpdates,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function userMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "user_message_chunk");
}

function agentMessageChunks(transcript: PromptSession['transcript']) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "agent_message_chunk");
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

    it('sends running/idle and renders items for a Codex turn that starts right after session/new, before any prompt has run', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const start = client.transcript.length;

        client.emit(turnStarted());
        await settle();
        client.emit(agentMessageDelta("Working on the goal"));
        await settle();
        client.emit(turnCompleted());
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(userMessageChunks(transcript)).toEqual([]);
        expect(agentMessageChunks(transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('sends running/idle and renders items for a Codex turn that starts right after session/resume, before any prompt has run', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await client.request("session/resume", {sessionId, cwd});
        const start = client.transcript.length;

        client.emit(turnStarted());
        await settle();
        client.emit(agentMessageDelta("Working on the goal"));
        await settle();
        client.emit(turnCompleted());
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(userMessageChunks(transcript)).toEqual([]);
        expect(agentMessageChunks(transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
    });

    it('does not double-render items for a turn a session/prompt owns', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        await response;
        client.emit(agentMessageDelta("Hi there"));
        await settle();
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(agentMessageChunks(client.transcript)).toEqual([
            expect.objectContaining({sessionUpdate: "agent_message_chunk"}),
        ]);
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

    it('interrupts unowned work and holds the next prompt until its cancelled idle', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);

        const start = client.transcript.length;
        client.emit(turnStarted("turn-2"));
        await client.waitForNotifications();
        await client.cancel();
        await vi.waitFor(() => expect(client.turnInterruptCalls()).toEqual([{threadId: sessionId, turnId: "turn-2"}]));
        const next = client.sendPrompt([{type: "text", text: "/status"}]);
        await client.request("session/list", {});
        expect(userMessageChunks(client.transcript.slice(start))).toEqual([]);
        client.emit({method: "turn/completed", params: {threadId: sessionId, turn: {
            id: "turn-2", rootTurnId: null, items: [], itemsView: "notLoaded", status: "interrupted",
            error: null, startedAt: null, completedAt: null, durationMs: null,
        }}});
        await next;
        await client.promptRunFinished(1);
        await client.request("session/list", {});
        expect(stateUpdates(client.transcript.slice(start))).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('reports lost root observability as unknown, then uses the fresh resume observation', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        client.emit(turnStarted("unowned"));
        client.emit({method: "thread/status/changed", params: {threadId: sessionId, status: {type: "notLoaded"}}});
        await client.waitForNotifications();
        await client.request("session/resume", {sessionId, cwd});
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "unknown"}, {state: "idle"}]);
    });

    it('withdraws an unowned turn’s pending approval without waiting for a late answer', async () => {
        let answer!: () => void;
        let signal!: AbortSignal;
        const client = await connectSession(2, {onRequestPermission: (request, cancelled) => {
            signal = cancelled;
            return new Promise(resolve => { answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}}); });
        }});
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);
        client.emit(turnStarted("goal"));
        await client.waitForNotifications();
        const approval = client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams({turnId: "goal"}));
        await vi.waitFor(() => expect(answer).toBeDefined());
        await client.cancel();
        await expect(approval).resolves.toEqual({decision: "cancel"});
        await vi.waitFor(() => expect(signal.aborted).toBe(true));
        answer();
    });

    it('resumes an unowned turn only after the runtime confirms progress following a permission answer', async () => {
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
        expect(stateUpdates(client.transcript.slice(start))).toEqual([{state: "running"}, {state: "requires_action"}]);
        client.emit({
            method: "thread/status/changed",
            params: {threadId: sessionId, status: {type: "active", activeFlags: []}},
        });
        await settle();

        client.emit(turnCompleted("turn-2"));
        await settle();

        const transcript = client.transcript.slice(start);
        // The runtime, not the permission response, establishes resumed progress.
        expect(stateUpdates(transcript)).toEqual([
            {state: "running"},
            {state: "requires_action"},
            {state: "running"},
            {state: "idle", stopReason: "end_turn"},
        ]);
        expect(userMessageChunks(transcript)).toEqual([]);
    });
});
