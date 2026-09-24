import {afterEach, describe, expect, it, vi} from 'vitest';
import {ResponseError} from 'vscode-jsonrpc';
import {
    sessionId,
    turnId,
    connectSession,
    createTurn,
    userMessageItem,
    itemStarted,
    itemCompleted,
    turnStarted,
    turnCompleted,
    settle,
    stateUpdates,
    indexOf,
    isState,
    turnFinished,
    dump,
    type PromptSession,
    type TranscriptEntry,
} from './v2-prompt-harness';
import type {ServerNotification} from '../../app-server';
import type {CodexErrorInfo, ErrorNotification, ThreadGoal, TurnCompletedNotification} from '../../app-server/v2';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';
import {CodexAcpServer} from '../../CodexAcpServer';

const typedFailureCapabilities = {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}}};

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

/** Sends a prompt and lets Codex record its user message; resolves once the prompt is answered. */
async function insertPrompt(client: PromptSession, index: number, id = turnId) {
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(index + 1));
    const clientUserMessageId = client.turnStartParams[index]!["clientUserMessageId"] as string;
    client.emit(turnStarted(id));
    client.emit(itemCompleted(userMessageItem(clientUserMessageId), id));
    const {messageId} = await response;
    return messageId as string;
}

function turnError(codexErrorInfo: CodexErrorInfo, message: string, id = turnId): ServerNotification {
    return {
        method: "error",
        params: {
            threadId: sessionId,
            turnId: id,
            willRetry: false,
            error: {message, codexErrorInfo, additionalDetails: null, misalignment: null},
        },
    };
}

function sessionUpdates(transcript: TranscriptEntry[]) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : []);
}

/** The transcript with the prompt's and the minted agent messages' ids replaced by placeholders. */
function stableTranscript(transcript: TranscriptEntry[], messageId: string): unknown {
    let json = dump(transcript, messageId);
    sessionUpdates(transcript).forEach(update => {
        if (update.sessionUpdate === "agent_message_chunk") {
            json = json.replaceAll(update.messageId as string, "<agentMessageId>");
        }
    });
    return JSON.parse(json);
}

describe('session/prompt over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('answers with the messageId only once Codex records the user message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        // A user message from someone else in the same turn does not insert this prompt.
        client.emit(itemCompleted(userMessageItem(null, "Other")));
        await settle();
        expect(client.transcript.some(entry => "promptResponse" in entry)).toBe(false);

        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(itemStarted(userMessageItem(clientUserMessageId)));
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        const {messageId} = await response;
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(clientUserMessageId).toEqual(expect.any(String));
        expect(messageId).toBe(clientUserMessageId);
        const userMessages = client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
            .filter(update => update.sessionUpdate === "user_message_chunk");
        expect(userMessages).toEqual([{sessionUpdate: "user_message_chunk", messageId, content: {type: "text", text: "Hello"}}]);
        // Insertion (response + user message) comes first, then `running`, then exactly one `idle`.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        const running = indexOf(client.transcript, isState("running"));
        expect(indexOf(client.transcript, entry => "promptResponse" in entry)).toBeLessThan(running);
        expect(indexOf(client.transcript, entry => "sessionUpdate" in entry
            && entry.sessionUpdate.sessionUpdate === "user_message_chunk")).toBeLessThan(running);
        expect(running).toBeLessThan(indexOf(client.transcript, isState("idle")));
        expect(indexOf(client.transcript, isState("idle")))
            .toBeGreaterThan(indexOf(client.transcript, entry => "codexNotification" in entry
                && entry.codexNotification === "turn/completed"));
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-inserted.json');
    });

    it('ends a turn that fails or is interrupted after insertion with one idle and the v1 stop reason', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const results = [];
        for (const [index, status] of (["failed", "interrupted"] as const).entries()) {
            const id = `turn-${index + 1}`;
            const start = client.transcript.length;
            const response = client.sendPrompt([{type: "text", text: "Hello"}]);
            await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(index + 1));
            const clientUserMessageId = client.turnStartParams[index]!["clientUserMessageId"] as string;
            client.emit(turnStarted(id));
            client.emit(itemCompleted(userMessageItem(clientUserMessageId), id));
            await response;
            client.emit(turnFinished(status, id));
            await client.promptRunFinished(index);
            await settle();
            results.push({status, transcript: JSON.parse(dump(client.transcript.slice(start), clientUserMessageId))});
            expect(stateUpdates(client.transcript.slice(start)))
                .toEqual([{state: "running"}, {state: "idle", stopReason: status === "failed" ? "end_turn" : "cancelled"}]);
        }

        await expect(dump(results)).toMatchFileSnapshot('data/prompt-v2-turn-failed-or-interrupted.json');
    });

    it('shows a usage-limit or auth error after insertion as agent text, then one idle/end_turn', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const results = [];
        for (const [index, [info, message]] of ([
            ["usageLimitExceeded", "You've hit your usage limit."],
            ["unauthorized", "Your access token could not be refreshed."],
        ] as const).entries()) {
            const id = `turn-${index + 1}`;
            const start = client.transcript.length;
            const messageId = await insertPrompt(client, index, id);
            client.emit(turnError(info, message, id));
            client.emit(turnFinished("failed", id));
            await client.promptRunFinished(index);
            await settle();

            const transcript = client.transcript.slice(start);
            // v1 fails this prompt with a JSON-RPC error; v2 has answered it already, so the
            // error text the turn sent is all the client gets, and the turn still ends.
            expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
            const agentMessages = sessionUpdates(transcript).filter(update => update.sessionUpdate === "agent_message_chunk");
            expect(agentMessages).toEqual([expect.objectContaining({content: {type: "text", text: `${message}\n\n`}})]);
            const text = indexOf(transcript, entry => "sessionUpdate" in entry
                && entry.sessionUpdate.sessionUpdate === "agent_message_chunk");
            expect(indexOf(transcript, isState("running"))).toBeLessThan(text);
            expect(text).toBeLessThan(indexOf(transcript, isState("idle")));
            results.push({info, transcript: stableTranscript(transcript, messageId)});
        }

        await expect(dump(results)).toMatchFileSnapshot('data/prompt-v2-turn-error-after-insertion.json');
    });

    it('puts a typed terminal failure on the idle _meta, not in a session update', async () => {
        const client = await connectSession(2, {clientCapabilities: typedFailureCapabilities});
        closeClient = () => client.connection.close();

        const start = client.transcript.length;
        const messageId = await insertPrompt(client, 0);
        client.emit(turnError("usageLimitExceeded", "You've hit your usage limit."));
        client.emit(turnFinished("failed"));
        await client.promptRunFinished();
        await settle();

        const transcript = client.transcript.slice(start);
        expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        // Reported once, as v1 reports it once on the prompt response.
        expect(sessionUpdates(transcript).map(update => update.sessionUpdate))
            .not.toEqual(expect.arrayContaining(["agent_message_chunk"]));
        expect(sessionUpdates(transcript).map(update => update.sessionUpdate))
            .not.toEqual(expect.arrayContaining(["session_info_update"]));
        const idle = sessionUpdates(transcript).at(-1) as {_meta?: Record<string, any>};
        expect(idle._meta?.["jetbrains"]?.air?.sessionFailure).toMatchObject({severity: "error"});
        expect(idle._meta?.["quota"]).toBeDefined();
        await expect(dump(stableTranscript(transcript, messageId)))
            .toMatchFileSnapshot('data/prompt-v2-typed-failure-after-insertion.json');

        // The session takes the next prompt.
        await insertPrompt(client, 1, "turn-2");
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
    });

    it('ends the turn with one idle when the Codex process exits after insertion', async () => {
        const results = [];
        for (const typed of [false, true]) {
            let exitCode: number | null = null;
            const client = await connectSession(2, {
                exitCode: () => exitCode,
                ...(typed ? {clientCapabilities: typedFailureCapabilities} : {}),
            });
            closeClient = () => client.connection.close();
            let loseTransport: (error: Error) => void = () => {};
            vi.spyOn(client.appServer, "awaitTurnCompleted").mockImplementation(() =>
                new Promise<TurnCompletedNotification>((_, reject) => {
                    loseTransport = reject;
                }));

            const start = client.transcript.length;
            const messageId = await insertPrompt(client, 0);
            exitCode = 1;
            loseTransport(new Error("connection closed"));
            await client.promptRunFinished();
            await settle();

            const transcript = client.transcript.slice(start);
            expect(stateUpdates(transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
            const agentMessages = sessionUpdates(transcript).filter(update => update.sessionUpdate === "agent_message_chunk");
            const idle = sessionUpdates(transcript).at(-1) as {_meta?: Record<string, any>};
            if (typed) {
                // Typed-failure clients get the synthetic `transport_lost` failure, as on v1.
                expect(agentMessages).toEqual([]);
                expect(idle._meta?.["jetbrains"]?.air?.sessionFailure).toMatchObject({category: "connection"});
            } else {
                expect(agentMessages).toEqual([expect.objectContaining({
                    content: {type: "text", text: "Codex process has exited with code 1"},
                })]);
                expect(idle._meta?.["jetbrains"]).toBeUndefined();
            }
            results.push({typed, transcript: stableTranscript(transcript, messageId)});
            client.connection.close();
            closeClient = null;
            expectConformingV2SessionUpdates();
        }

        await expect(dump(results)).toMatchFileSnapshot('data/prompt-v2-process-exit-after-insertion.json');
    });

    it('ends a failing local command with its error as agent text and one idle', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/name/set", async () => {
            throw new ResponseError(-32603, "thread name could not be saved");
        });

        const {messageId} = await client.sendPrompt([{type: "text", text: "/rename New name"}]);
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        const agentMessages = sessionUpdates(client.transcript).filter(update => update.sessionUpdate === "agent_message_chunk");
        expect(agentMessages).toEqual([expect.objectContaining({
            content: {type: "text", text: "The '/rename' command failed: thread name could not be saved"},
        })]);
        await expect(dump(stableTranscript(client.transcript, messageId)))
            .toMatchFileSnapshot('data/prompt-v2-local-command-failed.json');

        const second = client.sendPrompt([{type: "text", text: "/plan"}]);
        await expect(second).resolves.toEqual({messageId: expect.any(String)});
        await client.promptRunFinished(1);
    });

    it('carries the v1 usage and quota on the idle that ends a turn', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        await insertPrompt(client, 0);
        const breakdown = {
            totalTokens: 1200,
            inputTokens: 1000,
            cachedInputTokens: 400,
            cacheWriteInputTokens: 0,
            outputTokens: 200,
            reasoningOutputTokens: 50,
        };
        client.emit({
            method: "thread/tokenUsage/updated",
            params: {threadId: sessionId, turnId, tokenUsage: {total: breakdown, last: breakdown, modelContextWindow: 200000}},
        });
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        const idle = sessionUpdates(client.transcript).at(-1);
        await expect(dump(idle)).toMatchFileSnapshot('data/prompt-v2-idle-usage-and-quota.json');
    });

    it('fails the prompt when turn/start is rejected', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        client.setTurnStart(async () => {
            throw new ResponseError(-32600, "thread not found: thread-1");
        });

        const error = await client.sendPrompt([{type: "text", text: "Hello"}]).then(() => null, (err) => err);
        await client.promptRunFinished();

        expect(error).not.toBeNull();
        // Never inserted, so the session never left idle.
        expect(stateUpdates(client.transcript)).toEqual([]);
        // Not inserted: the prompt never happened from the client's view, so no title either.
        expect(sessionUpdates(client.transcript).map(update => update.sessionUpdate))
            .not.toEqual(expect.arrayContaining(["session_info_update"]));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        await expect(dump(client.transcript, clientUserMessageId))
            .toMatchFileSnapshot('data/prompt-v2-turn-start-rejected.json');
    });

    it('fails the prompt when the turn completes without recording the user message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        // E.g. a blocking UserPromptSubmit hook: the turn ends and Codex never records the prompt.
        client.emit(turnStarted());
        client.emit(turnCompleted());
        const error = await response.then(() => null, (err) => err);
        await client.promptRunFinished();

        expect(error).not.toBeNull();
        expect(client.transcript.some(entry => "sessionUpdate" in entry
            && entry.sessionUpdate.sessionUpdate === "user_message_chunk")).toBe(false);
        expect(stateUpdates(client.transcript)).toEqual([]);
        // Not inserted: the fallback title from the prompt text must not be published either.
        expect(sessionUpdates(client.transcript).map(update => update.sessionUpdate))
            .not.toEqual(expect.arrayContaining(["session_info_update"]));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        await expect(dump(client.transcript, clientUserMessageId)).toMatchFileSnapshot('data/prompt-v2-not-inserted.json');
    });

    it('queues a prompt that overlaps a running one instead of rejecting it', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;

        // B overlaps A: it is queued, not rejected. Nothing about it is observable yet.
        const second = client.sendPrompt([{type: "text", text: "Again"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);
        expect(client.transcript.filter(entry => "promptResponse" in entry || "promptError" in entry)).toHaveLength(1);
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        // A ends: idle(A) goes out, then B's turn starts.
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);

        const secondClientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(secondClientUserMessageId, "Again"), "turn-2"));
        const {messageId} = await second;
        expect(messageId).toBe(secondClientUserMessageId);

        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('queues multiple overlapping prompts and runs them in FIFO order', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "One"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;

        const second = client.sendPrompt([{type: "text", text: "Two"}]);
        const third = client.sendPrompt([{type: "text", text: "Three"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        client.emit(turnCompleted());
        await client.promptRunFinished();
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        // C stays queued behind B; it must not start alongside or ahead of it.
        await settle();
        expect(client.turnStartParams).toHaveLength(2);

        const secondClientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(secondClientUserMessageId, "Two"), "turn-2"));
        await second;
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);

        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(3));
        const thirdClientUserMessageId = client.turnStartParams[2]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-3"));
        client.emit(itemCompleted(userMessageItem(thirdClientUserMessageId, "Three"), "turn-3"));
        await third;
        client.emit(turnCompleted("turn-3"));
        await client.promptRunFinished(2);
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('queues a local slash command behind a running prompt', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;

        const second = client.sendPrompt([{type: "text", text: "/plan"}]);
        await settle();
        expect(client.transcript.filter(entry => "promptResponse" in entry || "promptError" in entry)).toHaveLength(1);
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);

        client.emit(turnCompleted());
        await client.promptRunFinished();

        const {messageId} = await second;
        expect(messageId).toEqual(expect.any(String));
        await client.promptRunFinished(1);
        await settle();

        // The local command never talks to Codex's turn machinery.
        expect(client.turnStartParams).toHaveLength(1);
        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('runs a queued prompt after the one ahead of it fails', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        await insertPrompt(client, 0);
        const second = client.sendPrompt([{type: "text", text: "Again"}]);
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        client.emit(turnError("usageLimitExceeded", "You've hit your usage limit."));
        client.emit(turnFinished("failed"));
        await client.promptRunFinished();
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);

        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const secondClientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(secondClientUserMessageId, "Again"), "turn-2"));
        await second;
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('takes the turn-start reservation synchronously, so two prompts sent back-to-back never race', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        // Neither request is awaited before the next is sent: this exercises the reservation
        // being taken before either prompt's handler has had a chance to run any async work.
        const first = client.sendPrompt([{type: "text", text: "One"}]);
        const second = client.sendPrompt([{type: "text", text: "Two"}]);

        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        await settle();
        expect(client.turnStartParams).toHaveLength(1);

        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        await first;
        client.emit(turnCompleted());
        await client.promptRunFinished();

        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const secondClientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(secondClientUserMessageId, "Two"), "turn-2"));
        await second;
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
            {state: "running"}, {state: "idle", stopReason: "end_turn"},
        ]);
    });

    it('keeps the turn going when a tool call cannot be rendered on v2 yet', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        await first;
        // A file edit: its diff content has no v2 rendering yet.
        client.emit(itemStarted({
            type: "fileChange",
            id: "item-edit",
            status: "inProgress",
            changes: [{path: "/workspace/new.ts", kind: {type: "add"}, diff: "export {};\n"}],
        }));
        client.emit(turnCompleted());
        await client.promptRunFinished();

        // The session is idle again: the next prompt starts a new turn.
        const second = client.sendPrompt([{type: "text", text: "Again"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const secondClientUserMessageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(secondClientUserMessageId, "Again"), "turn-2"));
        const {messageId} = await second;
        expect(messageId).toBe(secondClientUserMessageId);
        expect(secondClientUserMessageId).not.toBe(clientUserMessageId);
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
    });

    it('inserts a locally handled command itself', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const {messageId} = await client.sendPrompt([{type: "text", text: "/plan"}]);
        await client.promptRunFinished();
        await settle();

        expect(client.turnStartParams).toEqual([]);
        // response + user message → `running` → command output → `idle`/`end_turn`.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        const running = indexOf(client.transcript, isState("running"));
        expect(indexOf(client.transcript, entry => "promptResponse" in entry)).toBeLessThan(running);
        expect(running).toBeLessThan(indexOf(client.transcript, entry => "sessionUpdate" in entry
            && entry.sessionUpdate.sessionUpdate === "config_option_update"));
        expect(indexOf(client.transcript, entry => "sessionUpdate" in entry
            && entry.sessionUpdate.sessionUpdate === "config_option_update"))
            .toBeLessThan(indexOf(client.transcript, isState("idle")));
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-local-command.json');

        // The session is idle again afterwards.
        const second = client.sendPrompt([{type: "text", text: "/plan"}]);
        await expect(second).resolves.toEqual({messageId: expect.any(String)});
        await client.promptRunFinished(1);
    });

    it('sends a local command reply as its own agent message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const {messageId} = await client.sendPrompt([{type: "text", text: "/skills"}]);
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        const reply = client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
            .find(update => update.sessionUpdate === "agent_message_chunk") as {messageId: string} | undefined;
        expect(reply?.messageId).toEqual(expect.any(String));
        expect(reply?.messageId).not.toBe(messageId);
        await expect(dump(client.transcript, messageId).replaceAll(reply!.messageId, "<replyMessageId>"))
            .toMatchFileSnapshot('data/prompt-v2-local-command-reply.json');
        const second = client.sendPrompt([{type: "text", text: "/plan"}]);
        await expect(second).resolves.toEqual({messageId: expect.any(String)});
        await client.promptRunFinished(1);
    });

    it('runs /compact as a Codex command turn, inserting a live-only user message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "/compact"}]);
        const {messageId} = await response;
        client.emit(turnStarted());
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(client.turnStartParams).toEqual([]);
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-compact-command.json');
    });

    it('runs /goal <objective> as a Codex command turn, inserting a live-only user message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const goal = createThreadGoal();
        client.setCodexResponse("thread/goal/set", async () => ({goal}));

        const response = client.sendPrompt([{type: "text", text: "/goal Ship it"}]);
        const {messageId} = await response;
        client.emit({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}});
        client.emit(turnStarted());
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(client.turnStartParams).toEqual([]);
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-goal-command.json');
    });

    it('runs /goal resume as a Codex command turn, inserting a live-only user message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const goal = createThreadGoal({objective: "Resumed objective"});
        client.setCodexResponse("thread/goal/set", async () => ({goal}));

        const response = client.sendPrompt([{type: "text", text: "/goal resume"}]);
        const {messageId} = await response;
        client.emit({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}});
        client.emit(turnStarted());
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(client.turnStartParams).toEqual([]);
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-goal-resume-command.json');
    });

    it('fails the prompt when a Codex command turn is rejected before it starts', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        client.setCodexResponse("thread/compact/start", async () => {
            throw new ResponseError(-32600, "Cannot compact now");
        });

        const error = await client.sendPrompt([{type: "text", text: "/compact"}]).then(() => null, (err) => err);
        await client.promptRunFinished();

        expect(error).not.toBeNull();
        // Never inserted, so the session never left idle.
        expect(stateUpdates(client.transcript)).toEqual([]);
        await expect(dump(client.transcript)).toMatchFileSnapshot('data/prompt-v2-compact-turn-start-rejected.json');
    });

    it('ends a /compact turn that fails after insertion with one idle', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "/compact"}]);
        const {messageId} = await response;
        client.emit(turnStarted());
        client.emit(turnFinished("failed"));
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-compact-failed-after-insertion.json');
    });

    it('runs /review as a Codex command turn, inserting a live-only user message and hiding the reviewer prompt', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const parentTurnId = "review-parent";
        const childTurnId = "review-child";
        client.setCodexResponse("review/start", async () => ({
            reviewThreadId: sessionId,
            turn: createTurn("inProgress", parentTurnId),
        }));

        const response = client.sendPrompt([{type: "text", text: "/review"}]);
        const {messageId} = await response;
        // The review's own turn id (`parentTurnId`) is not the same as the reviewer's child turn
        // (`childTurnId`) that actually starts and is later interrupted: `review/start`'s response
        // is the completion id, `turn/started` is the interrupt id.
        client.emit(turnStarted(childTurnId));
        client.emit(itemCompleted({
            type: "enteredReviewMode",
            id: "entered-review",
            review: "current changes",
        }, parentTurnId));
        // Codex's own reviewer prompt, `clientId: null`, must never be surfaced as a user message.
        client.emit(itemCompleted(userMessageItem(null, "Review the current changes."), parentTurnId));
        client.emit(turnFinished("completed", parentTurnId));
        await client.promptRunFinished();
        await settle();

        expect(client.turnStartParams).toEqual([]);
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        const userMessages = sessionUpdates(client.transcript).filter(update => update.sessionUpdate === "user_message_chunk");
        expect(userMessages).toEqual([{sessionUpdate: "user_message_chunk", messageId, content: {type: "text", text: "/review"}}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-review-command.json');
    });

    it('fails the prompt when review/start is rejected before it starts', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        client.setCodexResponse("review/start", async () => {
            throw new ResponseError(-32600, "Cannot review right now");
        });

        const error = await client.sendPrompt([{type: "text", text: "/review"}]).then(() => null, (err) => err);
        await client.promptRunFinished();

        expect(error).not.toBeNull();
        // Never inserted, so the session never left idle.
        expect(stateUpdates(client.transcript)).toEqual([]);
        await expect(dump(client.transcript)).toMatchFileSnapshot('data/prompt-v2-review-turn-start-rejected.json');
    });

    it('ends a review Codex could not resolve before starting it with exactly one idle', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const parentTurnId = "review-parent";
        client.setCodexResponse("review/start", async () => ({
            reviewThreadId: sessionId,
            turn: createTurn("inProgress", parentTurnId),
        }));

        const response = client.sendPrompt([{type: "text", text: "/review"}]);
        const {messageId} = await response;
        // Codex reports a fatal, non-retried error under the review's turn id and never spawns the
        // reviewer: no `turn/started`, no `enteredReviewMode`, no `turn/completed`.
        const notGitRepositoryError: ErrorNotification["error"] = {
            message: "/test/cwd is not a git repository",
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
        };
        client.emit({
            method: "error",
            params: {threadId: sessionId, turnId: parentTurnId, willRetry: false, error: notGitRepositoryError},
        });
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(stableTranscript(client.transcript, messageId)))
            .toMatchFileSnapshot('data/prompt-v2-review-unspawned-error.json');
    });

    it('ends a /review turn that fails after insertion with one idle', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const parentTurnId = "review-parent";
        const childTurnId = "review-child";
        client.setCodexResponse("review/start", async () => ({
            reviewThreadId: sessionId,
            turn: createTurn("inProgress", parentTurnId),
        }));

        const response = client.sendPrompt([{type: "text", text: "/review"}]);
        const {messageId} = await response;
        client.emit(turnStarted(childTurnId));
        client.emit(turnFinished("failed", parentTurnId));
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-review-failed-after-insertion.json');
    });

    it('rejects content block types that only exist on v2', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const error = await client.sendPrompt([{type: "_custom", value: 1}]).then(
            () => null,
            (err) => ({code: err.code, message: err.message, data: err.data}),
        );

        expect(client.turnStartParams).toEqual([]);
        await expect(dump(error)).toMatchFileSnapshot('data/prompt-v2-unsupported-content.json');
    });

    it('shows a /goal resume continuation turn as its own live user message, with its own minted id', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const goal = createThreadGoal({objective: "Resumed objective"});
        client.setCodexResponse("thread/goal/set", async () => ({goal}));

        const response = client.sendPrompt([{type: "text", text: "/goal resume"}]);
        const {messageId} = await response;
        client.emit({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}});
        // Codex reports no active runtime turn for this goal within the grace window, so codex-acp
        // starts its own continuation turn with a freshly minted id.
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1), {timeout: 3000});
        const continuationId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        expect(continuationId).toEqual(expect.any(String));
        expect(continuationId).not.toBe(messageId);

        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(continuationId, "Continue working toward the active goal.")));
        await settle();
        const userMessages = sessionUpdates(client.transcript).filter(update => update.sessionUpdate === "user_message_chunk");
        expect(userMessages).toEqual([
            {sessionUpdate: "user_message_chunk", messageId, content: {type: "text", text: "/goal resume"}},
            {
                sessionUpdate: "user_message_chunk",
                messageId: continuationId,
                content: {type: "text", text: "Continue working toward the active goal."},
            },
        ]);

        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        // The continuation runs inside the original prompt's running…idle pair: no extra one.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId).replaceAll(continuationId, "<continuationId>"))
            .toMatchFileSnapshot('data/prompt-v2-goal-resume-continuation.json');
    }, 10000);

    it('shows the plan-implementation follow-up turn as its own live user message, with its own minted id', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        vi.spyOn(CodexAcpServer.prototype as any, "requestPlanImplementationPermission").mockResolvedValue(true);

        // Switch into plan mode first; `/plan` is a local command and starts no turn.
        await client.sendPrompt([{type: "text", text: "/plan"}]);
        await client.promptRunFinished(0);
        await settle();
        expect(client.turnStartParams).toEqual([]);
        const start = client.transcript.length;

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        const {messageId} = await response;
        client.emit(itemCompleted({type: "plan", id: "plan-item", text: "1. Do the change."}));
        client.emit(turnCompleted());

        // Approval is mocked, so codex-acp starts the "Implement the approved plan." turn itself,
        // still inside this same prompt.
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const implementationId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        expect(implementationId).toEqual(expect.any(String));
        expect(implementationId).not.toBe(messageId);
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(implementationId, "Implement the approved plan."), "turn-2"));
        await settle();
        const userMessages = sessionUpdates(client.transcript.slice(start)).filter(update => update.sessionUpdate === "user_message_chunk");
        expect(userMessages).toEqual([
            {sessionUpdate: "user_message_chunk", messageId, content: {type: "text", text: "Hello"}},
            {
                sessionUpdate: "user_message_chunk",
                messageId: implementationId,
                content: {type: "text", text: "Implement the approved plan."},
            },
        ]);

        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();

        // One running…idle pair for the whole exchange, despite the two turns.
        expect(stateUpdates(client.transcript.slice(start))).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript.slice(start), messageId).replaceAll(implementationId, "<implementationId>"))
            .toMatchFileSnapshot('data/prompt-v2-plan-implementation-turn.json');
    });

    it('leaves v1 session/prompt unchanged: no clientUserMessageId, answered at turn end', async () => {
        const client = await connectSession(1);
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(null)));
        await settle();
        expect(client.transcript.some(entry => "promptResponse" in entry)).toBe(false);
        client.emit(turnCompleted());
        await response;

        expect(client.turnStartParams[0]).not.toHaveProperty("clientUserMessageId");
        expect(stateUpdates(client.transcript)).toEqual([]);
        await expect(dump(client.transcript)).toMatchFileSnapshot('data/prompt-v2-v1-unchanged.json');
    });
});
