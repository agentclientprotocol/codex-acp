import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY} from '../../AirExtension';
import type {Thread} from '../../app-server/v2';
import {createCodexMockTestFixture, createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

const sessionId = "thread-1";
const cwd = "/workspace";

// UUIDv7-shaped turn ids (version nibble '7'), constructed so a plain string compare recovers
// chronological order except where a turn is deliberately minted "later" than its neighbor.
const P_ID = "01990000-0000-7000-8000-000000000001"; // review turn
const T_ID = "01990000-0000-7000-8000-000000000002"; // reviewer-prompt turn, minted after P_ID
const T2_ID = "01990000-0000-7000-8000-000000000003"; // an ordinary turn
const P2_ID = "01990000-0000-7000-8000-000000000004"; // a later review turn, T2_ID predates it normally

function createThread(overrides?: Partial<Thread>): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "Earlier session",
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
        ...overrides,
    };
}

/**
 * A thread shaped like real 0.156.1 `/review` history (research: `v2-resume-replay-open-
 * questions.md` Q2): a reviewer-prompt turn T immediately before its review turn P, with T
 * minted after P so its turn id sorts higher; plus an ordinary turn T2 that also happens to sit
 * right before a later review turn P2, but in chronological order (T2's id is lower), which must
 * NOT be hidden.
 */
const reviewReplayTurns: Thread["turns"] = [
    {
        id: T_ID,
        itemsView: "full",
        status: "interrupted",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {
                type: "userMessage",
                id: "reviewer-prompt",
                clientId: null,
                content: [{type: "text", text: "Please review my changes", text_elements: []}],
            },
            {type: "reasoning", id: "reviewer-reasoning", summary: ["Reviewing the diff"], content: []},
        ],
    },
    {
        id: P_ID,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {type: "enteredReviewMode", id: "review-entered", review: "Review the diff"},
            {type: "exitedReviewMode", id: "review-exited", review: "Looks good"},
            {
                type: "agentMessage",
                id: "review-summary",
                text: "Review complete.",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        ],
    },
    {
        id: T2_ID,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {
                type: "userMessage",
                id: "ordinary-prompt",
                clientId: null,
                content: [{type: "text", text: "Reply with just OK.", text_elements: []}],
            },
            {
                type: "agentMessage",
                id: "ordinary-reply",
                text: "OK",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        ],
    },
    {
        id: P2_ID,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
            {type: "enteredReviewMode", id: "review2-entered", review: "Second review"},
            {type: "exitedReviewMode", id: "review2-exited", review: "All good"},
            {
                type: "agentMessage",
                id: "review2-summary",
                text: "Second review complete.",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        ],
    },
];

/** Canned Codex app-server responses, keyed by method. */
function codexResponse(method: string, replayTurns: Thread["turns"] = [], threadPath: string | null = null): unknown {
    switch (method) {
        case "thread/start":
        case "thread/resume":
            return {
                thread: createThread(),
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
                turnsBackwardsCursor: null,
            };
        case "thread/read":
            return {thread: createThread({turns: replayTurns, path: threadPath})};
        case "model/list":
            return {data: [createTestModel({id: "gpt-5"})], nextCursor: null};
        case "skills/list":
            return {data: []};
        case "config/read":
            return {config: {}, origins: {}, layers: []};
        case "thread/list":
            return {data: [createThread()], nextCursor: null};
        case "thread/goal/get":
            return {goal: null};
        default:
            return {};
    }
}

/** Connects a v2 client to the agent through the router, over a mocked Codex app-server. */
async function connectV2Client(options?: {
    replayTurns?: Thread["turns"];
    capabilities?: acpV2.ClientCapabilities;
    threadPath?: string | null;
}) {
    const mocks = createMockConnections();
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string) => (
        codexResponse(method, options?.replayTurns, options?.threadPath ?? null)
    ));
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue({ready: [], failed: [], cancelled: []});
    const router = createAcpAgentRouter((connection) => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const updates: acpV2.UpdateSessionNotification[] = [];
    const connection = acpV2.client({name: "test-client"})
        .onNotification(acpV2.methods.client.session.update, (ctx) => {
            checkV2SessionUpdate(ctx.params.update);
            updates.push(ctx.params);
        })
        .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: {name: "test-client", version: "1.0.0"},
        ...(options?.capabilities ? {capabilities: options.capabilities} : {}),
    });
    return {connection, updates};
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/** The whole-message kind a replayed chunk restarts. */
const wholeMessageKindByChunk: Record<string, acpV2.SessionUpdate["sessionUpdate"]> = {
    user_message_chunk: "user_message",
    agent_message_chunk: "agent_message",
    agent_thought_chunk: "agent_thought",
};

/**
 * RESUME-205-style check: every replayed chunk with an id must be preceded (anywhere earlier in
 * the same session's update stream) by a whole-message update of the matching kind and id with
 * `content: []`, sent exactly once per id.
 */
function assertPrimerBeforeEveryChunk(updates: acpV2.UpdateSessionNotification[]): void {
    const primed = new Set<string>();
    for (let i = 0; i < updates.length; i++) {
        const update = updates[i]!.update;
        const wholeKind = wholeMessageKindByChunk[update.sessionUpdate];
        const messageId = (update as {messageId?: string | null}).messageId;
        if (!wholeKind || !messageId) continue;
        const key = `${wholeKind}:${messageId}`;
        if (primed.has(key)) continue;
        const hasPrimer = updates.slice(0, i).some((prior) => (
            prior.update.sessionUpdate === wholeKind
            && (prior.update as {messageId?: string}).messageId === messageId
            && Array.isArray((prior.update as {content?: unknown[]}).content)
            && (prior.update as {content: unknown[]}).content.length === 0
        ));
        expect(hasPrimer, `missing '${wholeKind}' primer before the first '${update.sessionUpdate}' for id ${messageId}`)
            .toBe(true);
        primed.add(key);
    }
}

/** `(sessionUpdate, messageId)` pairs for updates that carry a replay message id. */
function messageIdSequence(updates: acpV2.UpdateSessionNotification[]): Array<[string, string | null | undefined]> {
    return updates
        .filter(({update}) => "messageId" in update)
        .map(({update}) => [update.sessionUpdate, (update as {messageId?: string | null}).messageId]);
}

describe('ACP v2 resume replay: review-mode ids, reviewer-prompt hiding, primers', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('gives review-mode chunks a stable messageId, hides only the minted-after reviewer prompt, and primes every replayed chunk', async () => {
        const {connection, updates} = await connectV2Client({replayTurns: reviewReplayTurns});
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });

        const messages = updates.filter(({update}) => (
            update.sessionUpdate.endsWith("_message_chunk")
            || update.sessionUpdate === "agent_message"
            || update.sessionUpdate.endsWith("_thought_chunk")
            || update.sessionUpdate === "agent_thought"
        ));
        await expect(dump(messages)).toMatchFileSnapshot('data/v2-resume-replay-review-and-hide.json');
        assertPrimerBeforeEveryChunk(updates);
    });

    it('leaves the reviewer prompt visible on v1 (regression pin: hiding is v2 only)', async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: createThread(),
            model: model.id,
            modelProvider: "openai",
            cwd,
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({
            thread: createThread({turns: reviewReplayTurns}),
        });

        await agent.initialize({protocolVersion: 1});
        await agent.loadSession({sessionId, cwd, mcpServers: []});

        const userChunkTexts = fixture.getAcpConnectionEvents([])
            .filter((event) => event.method === "sessionUpdate")
            .map((event) => event.args[0].update)
            .filter((update: {sessionUpdate: string}) => update.sessionUpdate === "user_message_chunk")
            .map((update: {content: {type: string; text?: string}}) => (
                update.content.type === "text" ? update.content.text : null
            ));

        // v1 is unchanged by the hiding rule: both userMessages, including the reviewer prompt, replay.
        expect(userChunkTexts).toEqual(["Please review my changes", "Reply with just OK."]);
    });
});

describe('ACP v2 resume replay: native path primers and determinism', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    const nativeCapabilities: acpV2.ClientCapabilities = {
        _meta: {jetbrains: {air: {version: 1, capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS_KEY]}}},
    };

    it('primes chunked messages in the native (subagent-aware) replay path too', async () => {
        const {connection, updates} = await connectV2Client({
            replayTurns: reviewReplayTurns,
            capabilities: nativeCapabilities,
        });
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });

        assertPrimerBeforeEveryChunk(updates);
        // The reviewer-prompt hiding rule also applies to the native path.
        const userChunkIds = updates
            .filter(({update}) => update.sessionUpdate === "user_message_chunk")
            .map(({update}) => (update as {messageId?: string | null}).messageId);
        expect(userChunkIds).toEqual(["ordinary-prompt"]);
    });

    it('replays the same thread twice with identical message ids (native path, no fallback involved)', async () => {
        // Only Codex-native history items are used here (no `ResponseItemHistoryFallback`
        // involvement, since `thread.path` is null), so every id below already comes from a
        // stable source (`item.id`/`clientId`). The fallback's own determinism (it never emits
        // agent/thought chunks on v2, so there is no id to be stable or unstable) is pinned by
        // the sibling test below.
        const {connection: firstConnection, updates: firstUpdates} = await connectV2Client({
            replayTurns: reviewReplayTurns,
            capabilities: nativeCapabilities,
        });
        await firstConnection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });
        firstConnection.close();

        const {connection: secondConnection, updates: secondUpdates} = await connectV2Client({
            replayTurns: reviewReplayTurns,
            capabilities: nativeCapabilities,
        });
        closeClient = () => secondConnection.close();
        await secondConnection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });

        expect(messageIdSequence(secondUpdates)).toEqual(messageIdSequence(firstUpdates));
    });
});

describe('ACP v2 resume replay: response-item history fallback sends only recovered tool calls', () => {
    let closeClient: (() => void) | null = null;
    let tempDir: string | null = null;

    afterEach(async () => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
        if (tempDir) {
            await rm(tempDir, {recursive: true, force: true});
            tempDir = null;
        }
    });

    /**
     * A legacy rollout with a recovered tool call (`call-recovered`, missing from app-server
     * history) plus an unmatched fallback assistant message and an unmatched fallback reasoning
     * chunk. Neither text has a corresponding thread item, so `mergeHistoryUpdates`'s content-key
     * matching leaves them unconsumed.
     */
    function rolloutRecords(): unknown[] {
        return [
            {
                type: "event_msg",
                payload: {
                    type: "user_message",
                    message: "Find the missing helper",
                    images: [],
                    local_images: [],
                    text_elements: [],
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{type: "input_text", text: "Find the missing helper"}],
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    arguments: JSON.stringify({cmd: "rg helper src", workdir: cwd, yield_time_ms: 1000}),
                    call_id: "call-recovered",
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "function_call_output",
                    call_id: "call-recovered",
                    output: "Chunk ID: recovered\nProcess exited with code 0\nOutput:\nsrc/helper.ts\n",
                },
            },
            {
                type: "event_msg",
                payload: {
                    type: "user_message",
                    message: "Thanks",
                    images: [],
                    local_images: [],
                    text_elements: [],
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{type: "input_text", text: "Thanks"}],
                },
            },
            {
                type: "event_msg",
                payload: {type: "agent_reasoning", text: "Fallback-only reasoning text."},
            },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{type: "output_text", text: "Fallback-only reply text."}],
                },
            },
        ];
    }

    /**
     * The app-server history matching the rollout above, minus the recovered tool call and the
     * unmatched fallback assistant/reasoning text. `user-1`/`user-2` match the fallback's two
     * user records by content, so the fallback's tool call ends up merged in between them.
     */
    const fallbackReplayTurns: Thread["turns"] = [
        {
            id: "turn-1",
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            items: [
                {
                    type: "userMessage",
                    id: "user-1",
                    clientId: null,
                    content: [{type: "text", text: "Find the missing helper", text_elements: []}],
                },
            ],
        },
        {
            id: "turn-2",
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            items: [
                {
                    type: "userMessage",
                    id: "user-2",
                    clientId: null,
                    content: [{type: "text", text: "Thanks", text_elements: []}],
                },
                {
                    type: "agentMessage",
                    id: "agent-1",
                    text: "You're welcome.",
                    phase: null,
                    memoryCitation: null,
                    delivery: null,
                    questions: null,
                },
            ],
        },
    ];

    async function writeRollout(): Promise<string> {
        tempDir = await mkdtemp(join(tmpdir(), "codex-acp-v2-fallback-"));
        const rolloutPath = join(tempDir, "rollout.jsonl");
        await writeFile(
            rolloutPath,
            `${rolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
            "utf8",
        );
        return rolloutPath;
    }

    it('sends only the recovered tool call from the fallback, in position, and drops its unmatched agent/thought chunks', async () => {
        const rolloutPath = await writeRollout();
        const {connection, updates} = await connectV2Client({replayTurns: fallbackReplayTurns, threadPath: rolloutPath});
        closeClient = () => connection.close();

        await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });

        const relevant = updates.filter(({update}) => (
            update.sessionUpdate.endsWith("_message_chunk")
            || update.sessionUpdate.endsWith("_thought_chunk")
            || update.sessionUpdate === "tool_call"
            || update.sessionUpdate === "tool_call_update"
        ));
        await expect(dump(relevant)).toMatchFileSnapshot('data/v2-resume-replay-fallback-tool-call-only.json');

        // No fallback-only agent/thought text ever reaches the client on v2.
        const messageTexts = relevant
            .filter(({update}) => update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")
            .map(({update}) => (update as {content: {type: string; text?: string}}).content)
            .map((content) => (content.type === "text" ? content.text : null));
        expect(messageTexts).not.toContain("Fallback-only reply text.");
        expect(messageTexts).not.toContain("Fallback-only reasoning text.");
        assertPrimerBeforeEveryChunk(updates);
    });

    it('replays the same fallback-involving thread twice with identical message ids', async () => {
        const rolloutPath = await writeRollout();
        const {connection: firstConnection, updates: firstUpdates} = await connectV2Client({
            replayTurns: fallbackReplayTurns,
            threadPath: rolloutPath,
        });
        await firstConnection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });
        firstConnection.close();

        const {connection: secondConnection, updates: secondUpdates} = await connectV2Client({
            replayTurns: fallbackReplayTurns,
            threadPath: rolloutPath,
        });
        closeClient = () => secondConnection.close();
        await secondConnection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd,
            replayFrom: {type: "start"},
        });

        expect(messageIdSequence(secondUpdates)).toEqual(messageIdSequence(firstUpdates));
    });

    it('leaves the fallback agent chunk visible on v1 (regression pin: filtering is v2 only)', async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});

        const rolloutPath = await writeRollout();
        const thread = createThread({turns: fallbackReplayTurns, path: rolloutPath});
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread,
            model: model.id,
            modelProvider: "openai",
            cwd,
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread});

        await agent.initialize({protocolVersion: 1});
        await agent.loadSession({sessionId, cwd, mcpServers: []});

        const agentChunkTexts = fixture.getAcpConnectionEvents([])
            .filter((event) => event.method === "sessionUpdate")
            .map((event) => event.args[0].update)
            .filter((update: {sessionUpdate: string}) => update.sessionUpdate === "agent_message_chunk")
            .map((update: {content: {type: string; text?: string}}) => (
                update.content.type === "text" ? update.content.text : null
            ));

        // v1 is unchanged: the fallback's unmatched assistant text still replays.
        expect(agentChunkTexts).toContain("Fallback-only reply text.");
    });
});
