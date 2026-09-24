import {afterEach, describe, expect, it, vi} from 'vitest';
import {ResponseError} from 'vscode-jsonrpc';
import {
    sessionId,
    turnId,
    connectSession,
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
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

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
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        await expect(dump(client.transcript, clientUserMessageId)).toMatchFileSnapshot('data/prompt-v2-not-inserted.json');
    });

    it('rejects a prompt that overlaps a running one', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        await first;

        const error = await client.sendPrompt([{type: "text", text: "Again"}]).then(() => null, (err) => err);
        expect(error?.code).toBe(-32600);
        expect(client.turnStartParams).toHaveLength(1);

        client.emit(turnCompleted());
        await client.promptRunFinished();
        await expect(dump({code: error.code, message: error.message, data: error.data}))
            .toMatchFileSnapshot('data/prompt-v2-overlap-rejected.json');
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

    it('rejects commands that run a Codex turn until they are supported on v2', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const errors = [];
        for (const text of ["/compact", "/review", "/review-branch main", "/goal ship it", "/goal resume"]) {
            errors.push(await client.sendPrompt([{type: "text", text}]).then(
                () => null,
                (err) => ({text, code: err.code, message: err.message, data: err.data}),
            ));
        }

        expect(client.transcript.filter(entry => "codexRequest" in entry)).toEqual([]);
        await expect(dump(errors)).toMatchFileSnapshot('data/prompt-v2-codex-turn-commands.json');
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
