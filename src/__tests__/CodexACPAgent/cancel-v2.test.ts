import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {CommandExecutionApprovalRequest} from '../../CodexAppServerClient';
import type {CommandExecutionRequestApprovalParams} from '../../app-server/v2';
import {
    connectSession,
    createTurn,
    userMessageItem,
    itemCompleted,
    turnStarted,
    turnCompleted,
    turnFinished,
    settle,
    stateUpdates,
    dump,
    sessionId,
    turnId,
    cwd,
    type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

function commandApprovalParams(): CommandExecutionRequestApprovalParams {
    return {
        kind: "command",
        threadId: sessionId,
        turnId,
        itemId: "cmd-item-1",
        startedAtMs: 0,
        environmentId: null,
        command: "ls -la",
        cwd,
    };
}

/** Starts a prompt and lets its turn actually start, without inserting its user message yet. */
async function startRunningPrompt(client: PromptSession) {
    client.setTurnStart(async () => ({
        turn: createTurn("inProgress"),
    }));
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    return {response, clientUserMessageId};
}

describe('session/cancel and session/close over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('cancels a running prompt with exactly one idle/cancelled', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await response;

        await client.cancel();
        client.emit(turnFinished("interrupted"));
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "cancelled"}]);
        await expect(dump(client.transcript, client.turnStartParams[0]!["clientUserMessageId"] as string))
            .toMatchFileSnapshot('data/cancel-v2-running-prompt.json');
    });

    it('drops queued prompts with -32800 on cancel, and lets a later prompt run normally', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "One"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;

        // B and C queue behind the running turn: nothing about them is observable yet.
        const second = client.sendPrompt([{type: "text", text: "Two"}]);
        const third = client.sendPrompt([{type: "text", text: "Three"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        await client.cancel();
        // B and C are rejected immediately -- they never wait for A's interrupt to land.
        await expect(second).rejects.toMatchObject({code: -32800});
        await expect(third).rejects.toMatchObject({code: -32800});
        client.emit(turnFinished("interrupted"));
        await client.promptRunFinished();
        await settle();

        // Neither B ("Two") nor C ("Three") ever reached `turn/start` or sent a user message.
        expect(client.turnStartParams).toHaveLength(1);
        const userMessageTexts = client.transcript.flatMap(entry => {
            if (!("sessionUpdate" in entry) || entry.sessionUpdate.sessionUpdate !== "user_message_chunk") {
                return [];
            }
            const content = entry.sessionUpdate.content as {type: string, text?: string};
            return content.type === "text" ? [content.text] : [];
        });
        expect(userMessageTexts).not.toEqual(expect.arrayContaining(["Two", "Three"]));
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "cancelled"}]);

        // The queue is empty afterwards: a fresh prompt runs like normal, not as if still queued.
        const fourth = client.sendPrompt([{type: "text", text: "Four"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[1]!["clientUserMessageId"] as string, "Four"), "turn-2"));
        const {messageId} = await fourth;
        expect(messageId).toBe(client.turnStartParams[1]!["clientUserMessageId"]);
        client.emit({method: "turn/completed", params: {threadId: "thread-1", turn: createTurn("completed", "turn-2")}});
        await client.promptRunFinished(1);
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "cancelled"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('drops a queued prompt with -32800 on session/close', async () => {
        const client = await connectSession();
        closeClient = null; // closeSession below already tears the session down.

        const first = client.sendPrompt([{type: "text", text: "One"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;

        const second = client.sendPrompt([{type: "text", text: "Two"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        const closed = client.request("session/close", {sessionId: "thread-1"});
        await expect(second).rejects.toMatchObject({code: -32800});
        client.emit(turnFinished("interrupted"));
        await client.promptRunFinished();
        await closed;

        expect(client.turnStartParams).toHaveLength(1);
        client.connection.close();
    });

    it('fails an adopted-but-not-landed prompt with -32800 when its turn is cancelled', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        // An unowned turn (e.g. a `/goal` auto-continuation) is already running.
        client.emit(turnStarted("goal-turn"));
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        const start = client.transcript.length;
        client.setTurnStart(async () => ({turn: createTurn("inProgress", "goal-turn")}));
        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));

        await client.cancel();
        // Codex drops the steered input: the adopted turn is interrupted before it lands.
        client.emit(turnFinished("interrupted", "goal-turn"));
        await client.promptRunFinished();
        await settle();

        await expect(response).rejects.toMatchObject({code: -32800});
        const transcript = client.transcript.slice(start);
        expect(transcript.some(entry => "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "user_message_chunk"))
            .toBe(false);
        // Exactly one `idle` for the adopted turn: nothing else will send it, since this prompt
        // is the one that claimed ownership (and suppressed the baseline unowned-turn tracker).
        expect(stateUpdates(transcript)).toEqual([{state: "idle", stopReason: "cancelled"}]);
    });

    it('drops one queued prompt via `$/cancel_request`, leaving the other to run normally', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "One"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;

        // B and C both queue behind the running turn.
        const controllerB = new AbortController();
        const second = client.sendPrompt([{type: "text", text: "Two"}], controllerB.signal);
        const third = client.sendPrompt([{type: "text", text: "Three"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        // Only B's request is cancelled: C is untouched, and the running turn keeps going.
        controllerB.abort();
        await expect(second).rejects.toMatchObject({code: -32800});
        await settle();
        expect(client.turnInterruptCalls()).toEqual([]);

        client.emit(turnFinished("completed"));
        await client.promptRunFinished();
        await settle();

        // C still runs once A finishes: dropping B did not disturb its FIFO slot.
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[1]!["clientUserMessageId"] as string, "Three"), "turn-2"));
        const {messageId} = await third;
        expect(messageId).toBe(client.turnStartParams[1]!["clientUserMessageId"]);
        client.emit({method: "turn/completed", params: {threadId: "thread-1", turn: createTurn("completed", "turn-2")}});
        await client.promptRunFinished(1);
        await settle();

        const userMessageTexts = client.transcript.flatMap(entry => {
            if (!("sessionUpdate" in entry) || entry.sessionUpdate.sessionUpdate !== "user_message_chunk") {
                return [];
            }
            const content = entry.sessionUpdate.content as {type: string, text?: string};
            return content.type === "text" ? [content.text] : [];
        });
        expect(userMessageTexts).not.toEqual(expect.arrayContaining(["Two"]));
        expect(userMessageTexts).toEqual(expect.arrayContaining(["One", "Three"]));
        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('interrupts and drops a started-but-not-inserted prompt on `$/cancel_request`', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const controller = new AbortController();
        const response = client.sendPrompt([{type: "text", text: "Hello"}], controller.signal);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));

        controller.abort();
        // Its own turn (not adopted from anyone else) is interrupted, like v1's per-request cancel.
        await vi.waitFor(() => expect(client.turnInterruptCalls()).toEqual([
            {threadId: "thread-1", turnId: "turn-1"},
        ]));

        await expect(response).rejects.toMatchObject({code: -32800});
        client.emit(turnFinished("interrupted"));
        await client.promptRunFinished();
        await settle();

        expect(client.transcript.some(entry => "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "user_message_chunk"))
            .toBe(false);
        // No `running`/`idle` pair: the request never got far enough to send `running`.
        expect(stateUpdates(client.transcript)).toEqual([]);
    });

    it('does not interrupt an adopted turn on `$/cancel_request`, but still drops the pending request', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        // An unowned turn (e.g. a `/goal` auto-continuation) is already running.
        client.emit(turnStarted("goal-turn"));
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        const start = client.transcript.length;
        client.setTurnStart(async () => ({turn: createTurn("inProgress", "goal-turn")}));
        const controller = new AbortController();
        const response = client.sendPrompt([{type: "text", text: "Hello"}], controller.signal);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));

        controller.abort();
        await expect(response).rejects.toMatchObject({code: -32800});
        await settle();
        // The adopted turn belongs to someone else (the goal continuation): a per-request cancel
        // must not touch it.
        expect(client.turnInterruptCalls()).toEqual([]);

        // The goal turn finishes normally on its own, unaffected by the dropped request.
        client.emit(turnFinished("completed", "goal-turn"));
        await client.promptRunFinished();
        await settle();

        const transcript = client.transcript.slice(start);
        expect(transcript.some(entry => "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "user_message_chunk"))
            .toBe(false);
        // This prompt claimed ownership of the adopted turn, so it alone reports the matching
        // `idle` once the turn actually finishes -- with the turn's real outcome, not `cancelled`.
        expect(stateUpdates(transcript)).toEqual([{state: "idle", stopReason: "end_turn"}]);
    });

    it('is a no-op for a late `$/cancel_request` after the prompt was already inserted', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const controller = new AbortController();
        const response = client.sendPrompt([{type: "text", text: "Hello"}], controller.signal);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        const {messageId} = await response;
        expect(messageId).toBe(client.turnStartParams[0]!["clientUserMessageId"]);

        controller.abort();
        await settle();
        expect(client.turnInterruptCalls()).toEqual([]);

        client.emit(turnFinished("completed"));
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
    });

    it('aborts a pending command approval on session/cancel and ends with exactly one idle/cancelled', async () => {
        const permission = deferred<acpV2.RequestPermissionResponse>();
        let capturedSignal: AbortSignal | undefined;
        const client = await connectSession(2, {
            onRequestPermission: async (_request, signal) => {
                capturedSignal = signal;
                return permission.promise;
            },
        });
        closeClient = () => client.connection.close();

        const {response, clientUserMessageId} = await startRunningPrompt(client);
        const start = client.transcript.length;

        const approvalPromise = client.triggerApproval(CommandExecutionApprovalRequest.method, commandApprovalParams());
        await vi.waitFor(() => expect(capturedSignal).toBeDefined());
        expect(capturedSignal!.aborted).toBe(false);

        await client.cancel();
        await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));

        // A conforming client answers `cancelled` once it has seen `session/cancel`.
        permission.resolve({outcome: {outcome: "cancelled"}});
        expect(await approvalPromise).toEqual({decision: "cancel"});

        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        client.emit(turnFinished("interrupted"));
        await response;
        await client.promptRunFinished();
        await settle();

        // The trailing extra `running` (before settling to `idle`) reflects a late permission
        // answer arriving after cancellation; scoping that transition is a separate concern.
        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([
            {state: "requires_action"},
            {state: "running"},
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);
    });

    it('ends the plan-implementation review as idle/cancelled, not idle/end_turn, on session/cancel', async () => {
        const permission = deferred<acpV2.RequestPermissionResponse>();
        let capturedSignal: AbortSignal | undefined;
        const client = await connectSession(2, {
            onRequestPermission: async (_request, signal) => {
                capturedSignal = signal;
                return permission.promise;
            },
        });
        closeClient = () => client.connection.close();

        // Switch into plan mode first; `/plan` is a local command and starts no turn.
        await client.sendPrompt([{type: "text", text: "/plan"}]);
        await client.promptRunFinished(0);
        await settle();

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        await response;
        client.emit(itemCompleted({type: "plan", id: "plan-item", text: "1. Do the change."}));
        client.emit(turnCompleted());

        await vi.waitFor(() => expect(capturedSignal).toBeDefined());
        const start = client.transcript.length;

        // The plan turn has already completed, so `turn/interrupt` targets its stale turn id and
        // has no real effect; codex-acp must still end the prompt as cancelled via `cancelRequested`.
        await client.cancel();
        await vi.waitFor(() => expect(capturedSignal!.aborted).toBe(true));

        permission.resolve({outcome: {outcome: "cancelled"}});
        await client.promptRunFinished(1);
        await settle();

        // No implementation turn is started once the review is cancelled.
        expect(client.turnStartParams).toHaveLength(1);
        // The leading `running` (before settling to `idle`) reflects a late permission answer
        // arriving after cancellation; scoping that transition is a separate concern.
        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([
            {state: "running"},
            {state: "idle", stopReason: "cancelled"},
        ]);
    });
});
