import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {ResponseError} from 'vscode-jsonrpc';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {ServerNotification} from '../../app-server';
import type {Thread, ThreadItem, Turn, TurnStatus} from '../../app-server/v2';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';

const sessionId = "thread-1";
const turnId = "turn-1";
const cwd = "/workspace";
const titleThreadId = "title-thread";

function createThread(): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 100,
        updatedAt: 200,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd,
        cliVersion: "0.0.0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
}

function createTurn(status: TurnStatus, id = turnId): Turn {
    return {
        id,
        items: [],
        itemsView: "notLoaded",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

/** Canned Codex app-server responses, keyed by method. */
function codexResponse(method: string): unknown {
    switch (method) {
        case "thread/start":
            return {
                thread: createThread(),
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
                turnsBackwardsCursor: null,
            };
        case "model/list":
            return {data: [createTestModel({id: "gpt-5"})], nextCursor: null};
        case "skills/list":
            return {data: []};
        case "config/read":
            return {config: {}, origins: {}, layers: []};
        case "thread/goal/get":
            return {goal: null};
        default:
            return {};
    }
}

/** The client-visible transcript of a prompt, in wire order. */
type TranscriptEntry =
    | {codexRequest: string, params: unknown}
    | {codexResponse: string}
    | {codexNotification: string}
    | {sessionUpdate: acpV2.SessionUpdate}
    | {promptResponse: unknown}
    | {promptError: unknown};

/** Connects a client (v2 by default) to the agent through the router, over a mocked Codex app-server, and opens a session. */
async function connectSession(protocolVersion: 1 | 2 = 2) {
    const mocks = createMockConnections();
    const transcript: TranscriptEntry[] = [];
    const turnStartParams: Array<Record<string, unknown>> = [];
    let turnStart: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
        turn: createTurn("inProgress", `turn-${turnStartParams.length}`),
    });
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params?: any) => {
        // The session title is generated on a separate ephemeral thread; keep it out of the way.
        if (method === "thread/start" && params?.ephemeral) {
            return {thread: {...createThread(), id: titleThreadId, ephemeral: true}};
        }
        if (method === "turn/start" && params?.threadId === titleThreadId) {
            return {turn: createTurn("inProgress", "title-turn")};
        }
        if (method !== "turn/start") {
            return codexResponse(method);
        }
        turnStartParams.push(params as Record<string, unknown>);
        transcript.push({codexRequest: method, params});
        const response = await turnStart(params as Record<string, unknown>);
        transcript.push({codexResponse: method});
        return response;
    });
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue({ready: [], failed: [], cancelled: []});
    let agent: CodexAcpServer | null = null;
    const router = createAcpAgentRouter((connection) => {
        agent = new CodexAcpServer(connection, codexAcpClient);
        return agent;
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    let recordUpdates = false;
    const setupUpdates: string[] = [];
    const onUpdate = (update: acpV2.SessionUpdate | acp.SessionUpdate) => {
        if (recordUpdates) {
            transcript.push({sessionUpdate: update as acpV2.SessionUpdate});
        } else {
            setupUpdates.push(update.sessionUpdate);
        }
    };
    const clientStream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);
    let connection: {close(): void};
    let request: (method: string, params: unknown) => Promise<any>;
    if (protocolVersion === 2) {
        const v2Connection = acpV2.client({name: "test-client"})
            .onNotification(acpV2.methods.client.session.update, (ctx) => onUpdate(ctx.params.update))
            .connect(clientStream);
        await v2Connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: {name: "test-client", version: "1.0.0"},
        });
        await v2Connection.agent.request(acpV2.methods.agent.session.new, {cwd});
        connection = v2Connection;
        request = (method, params) => v2Connection.agent.request(method as typeof acpV2.methods.agent.session.prompt, params as acpV2.PromptRequest);
    } else {
        const v1Connection = acp.client({name: "test-client"})
            .onNotification(acp.methods.client.session.update, (ctx) => onUpdate(ctx.params.update))
            .connect(clientStream);
        await v1Connection.agent.request(acp.methods.agent.initialize, {protocolVersion: acp.PROTOCOL_VERSION});
        await v1Connection.agent.request(acp.methods.agent.session.new, {cwd, mcpServers: []});
        connection = v1Connection;
        request = (method, params) => v1Connection.agent.request(method as typeof acp.methods.agent.session.prompt, params as acp.PromptRequest);
    }
    const promptSpy = vi.spyOn(agent!, "prompt");
    // Session setup publishes updates of its own; wait for them before recording the prompt.
    await vi.waitFor(() => expect(setupUpdates).toContain("available_commands_update"));
    recordUpdates = true;

    const emit = (notification: ServerNotification) => {
        transcript.push({codexNotification: notification.method});
        mocks.getUnhandledNotificationHandler()!(notification);
    };

    const sendPrompt = (prompt: acpV2.ContentBlock[]) => {
        const response = request("session/prompt", {sessionId, prompt}).then(
            (result) => {
                transcript.push({promptResponse: result});
                return result;
            },
            (error) => {
                transcript.push({promptError: {code: error.code, message: error.message, data: error.data}});
                throw error;
            },
        );
        response.catch(() => {});
        return response;
    };

    return {
        connection,
        transcript,
        turnStartParams,
        setTurnStart: (handler: typeof turnStart) => {
            turnStart = handler;
        },
        emit,
        sendPrompt,
        /** Resolves when the n-th internal prompt run (including its background turn) has finished. */
        promptRunFinished: async (index = 0) => {
            await vi.waitFor(() => expect(promptSpy.mock.results.length).toBeGreaterThan(index));
            await promptSpy.mock.results[index]!.value.catch(() => {});
        },
    };
}

function userMessageItem(clientId: string | null, text = "Hello"): ThreadItem {
    return {type: "userMessage", id: "item-user", clientId, content: [{type: "text", text, text_elements: []}]};
}

function itemStarted(item: ThreadItem, id = turnId): ServerNotification {
    return {method: "item/started", params: {threadId: sessionId, turnId: id, item, startedAtMs: 0}};
}

function itemCompleted(item: ThreadItem, id = turnId): ServerNotification {
    return {method: "item/completed", params: {threadId: sessionId, turnId: id, item, completedAtMs: 0}};
}

function turnStarted(id = turnId): ServerNotification {
    return {method: "turn/started", params: {threadId: sessionId, turn: createTurn("inProgress", id)}};
}

function turnCompleted(id = turnId): ServerNotification {
    return {method: "turn/completed", params: {threadId: sessionId, turn: createTurn("completed", id)}};
}

/** Lets queued notifications and wire messages settle. */
async function settle() {
    await new Promise(resolve => setTimeout(resolve, 20));
}

/** The `state_update`s in the transcript, in wire order. */
function stateUpdates(transcript: TranscriptEntry[]): Array<{state: string, stopReason?: unknown}> {
    return transcript.flatMap(entry => "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "state_update"
        ? [{...entry.sessionUpdate} as {state: string, stopReason?: unknown}]
        : [])
        .map(({state, stopReason}) => stopReason === undefined ? {state} : {state, stopReason});
}

/** Index of the first transcript entry matching the predicate. */
function indexOf(transcript: TranscriptEntry[], predicate: (entry: TranscriptEntry) => boolean): number {
    return transcript.findIndex(predicate);
}

const isState = (state: string) => (entry: TranscriptEntry) =>
    "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "state_update"
    && (entry.sessionUpdate as {state: string}).state === state;

function turnFinished(status: TurnStatus, id = turnId): ServerNotification {
    return {method: "turn/completed", params: {threadId: sessionId, turn: createTurn(status, id)}};
}

function dump(value: unknown, messageId?: string): string {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    return messageId ? json.replaceAll(messageId, "<messageId>") : json;
}

describe('session/prompt over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
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

    it('keeps the turn going when an agent message cannot be rendered on v2 yet', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const first = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        await first;
        client.emit({
            method: "item/agentMessage/delta",
            params: {threadId: sessionId, turnId, itemId: "item-agent", delta: "Hi"},
        });
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

    it('stays usable after a local command whose reply cannot be rendered on v2 yet', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();

        const {messageId} = await client.sendPrompt([{type: "text", text: "/skills"}]);
        await client.promptRunFinished();
        await settle();

        // The reply fails after insertion. What a v2 client should see then is not decided yet, so
        // this known gap sends no `idle`.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}]);
        await expect(dump(client.transcript, messageId)).toMatchFileSnapshot('data/prompt-v2-local-command-reply.json');
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
