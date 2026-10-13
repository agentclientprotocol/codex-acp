import {afterEach, describe, expect, it, vi} from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {z} from 'zod';
import {createAcpAgentRouter} from '../../AcpAgentRouter';
import {CodexAcpServer} from '../../CodexAcpServer';
import {CodexAcpClient} from '../../CodexAcpClient';
import {CodexAppServerClient} from '../../CodexAppServerClient';
import type {Thread} from '../../app-server/v2';
import {
    SESSION_ARCHIVE_METHOD,
    SESSION_LIST_CHANGES_METHOD,
    SESSION_LIST_SUBSCRIBE_METHOD,
    SESSION_LIST_UNSUBSCRIBE_METHOD,
    SESSION_RENAME_METHOD,
    SESSION_UNARCHIVE_METHOD,
} from '../../SessionIndex';
import {MAX_SESSION_TITLE_LENGTH} from '../../SessionTitle';
import {createTestModel} from '../acp-test-utils';
import {createMockConnections} from './test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

const sessionId = "thread-1";
const cwd = "/workspace";

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
        model: "gpt-5",
        reasoningEffort: null,
        createdAt: 100,
        updatedAt: 200,
        recencyAt: 300,
        status: {type: "notLoaded"},
        path: null,
        cwd,
        cliVersion: "0.0.0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        ...overrides,
    };
}

/** Replaces the canned `thread/list` rows or `thread/read` thread. */
type CodexOverrides = {threads?: Thread[], threadRead?: Thread};

function codexResponse(method: string, overrides: CodexOverrides): unknown {
    switch (method) {
        case "thread/start":
            return {
                thread: createThread({status: {type: "idle"}}),
                model: "gpt-5",
                modelProvider: "openai",
                reasoningEffort: "medium",
                serviceTier: null,
            };
        case "thread/read":
            return {thread: overrides.threadRead ?? createThread({
                status: {type: "active", activeFlags: []},
                name: "Renamed",
                path: "/codex-home/sessions/rollout.jsonl",
            })};
        case "thread/list":
            return {data: overrides.threads ?? [createThread()], nextCursor: null, backwardsCursor: null};
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

/** Methods whose requests the snapshots record; the rest is session-setup noise. */
const recordedCodexMethods = new Set([
    "thread/list",
    "thread/name/set",
    "thread/archive",
    "thread/unarchive",
]);

async function connectV2Client(airCapabilities: string[], overrides: CodexOverrides = {}) {
    const mocks = createMockConnections();
    const codexRequests: Array<{method: string, params: unknown}> = [];
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
        if (recordedCodexMethods.has(method)) {
            codexRequests.push({method, params});
        }
        return codexResponse(method, overrides);
    });
    const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
    vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockResolvedValue({ready: [], failed: [], cancelled: []});
    const router = createAcpAgentRouter((connection) => new CodexAcpServer(connection, codexAcpClient));
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const updates: acpV2.UpdateSessionNotification[] = [];
    const listChanges: unknown[] = [];
    const connection = acpV2.client({name: "test-client"})
        .onNotification(acpV2.methods.client.session.update, (ctx) => {
            checkV2SessionUpdate(ctx.params.update);
            updates.push(ctx.params);
        })
        .onNotification(SESSION_LIST_CHANGES_METHOD, z.object({}).passthrough(), (ctx) => {
            listChanges.push(ctx.params);
        })
        .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));
    const initialize = await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: {name: "test-client", version: "1.0.0"},
        capabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: airCapabilities}}}},
    });
    const sendServerNotification = (notification: unknown) => mocks.getUnhandledNotificationHandler()?.(notification);
    return {connection, initialize, codexRequests, updates, listChanges, sendServerNotification};
}

function airCapabilitiesOf(response: acpV2.InitializeResponse): unknown {
    return (response._meta as any)?.jetbrains?.air?.capabilities ?? null;
}

function dump(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

describe('AIR sessionIndex over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.useRealTimers();
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('neither advertises nor serves sessionIndex to a v2 client that does not declare it', async () => {
        const {connection, initialize} = await connectV2Client([]);
        closeClient = () => connection.close();

        expect(airCapabilitiesOf(initialize)).not.toContain("sessionIndex");
        await expect(connection.agent.request(SESSION_RENAME_METHOD, {sessionId, title: "Renamed"}))
            .rejects.toMatchObject({code: -32601});
    });

    it('lists, renames, archives and unarchives sessions', async () => {
        const {connection, initialize, codexRequests, updates} = await connectV2Client(["sessionIndex"]);
        closeClient = () => connection.close();
        await connection.agent.request(acpV2.methods.agent.session.new, {cwd});
        await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
        updates.length = 0;

        const list = await connection.agent.request(acpV2.methods.agent.session.list, {
            cwd,
            _meta: {jetbrains: {air: {list: {limit: 10}}}},
        });
        const rename = await connection.agent.request(SESSION_RENAME_METHOD, {sessionId, title: "Renamed"});
        // The session is open here: archiving closes it and tells the client why.
        const archive = await connection.agent.request(SESSION_ARCHIVE_METHOD, {sessionId});
        const unarchive = await connection.agent.request(SESSION_UNARCHIVE_METHOD, {sessionId});

        await expect(dump({
            capabilities: airCapabilitiesOf(initialize),
            list,
            rename,
            archive,
            unarchive,
            codexRequests,
            updates: updates.filter(({update}) => update.sessionUpdate === "session_info_update"),
        })).toMatchFileSnapshot('data/session-index-v2.json');
    });

    it('pushes the changed rows of a subscription', async () => {
        const {connection, listChanges, sendServerNotification} = await connectV2Client(["sessionIndex"]);
        closeClient = () => connection.close();

        const {subscriptionId} = await connection.agent.request(SESSION_LIST_SUBSCRIBE_METHOD, {cwd}) as {subscriptionId: string};
        sendServerNotification({
            method: "thread/status/changed",
            params: {threadId: sessionId, status: {type: "active", activeFlags: []}},
        });
        await vi.waitFor(() => expect(listChanges).toHaveLength(1));
        const unsubscribe = await connection.agent.request(SESSION_LIST_UNSUBSCRIBE_METHOD, {subscriptionId});

        await expect(dump({
            listChanges: listChanges.map((change: any) => ({...change, subscriptionId: "<subscriptionId>"})),
            unsubscribe,
        })).toMatchFileSnapshot('data/session-index-v2-subscription.json');
    });
    // #606: rows are titled by the first non-blank of name, title, summary and preview, without a cut.
    it.each([[["sessionIndex"]], [[]]])('titles session/list rows by name, title, summary, then preview (AIR capabilities: %j)', async (airCapabilities) => {
        const longPreview = `Investigate ${"x".repeat(MAX_SESSION_TITLE_LENGTH)}\n end`;
        const {connection} = await connectV2Client(airCapabilities, {threads: [
            createThread({id: "named", name: " Named\n thread ", recencyAt: 50}),
            createThread({id: "blank-name", name: " ", preview: longPreview, recencyAt: 40}),
            {...createThread({id: "summarized", name: null, recencyAt: 30}), title: null, summary: "Summary"} as Thread,
            createThread({id: "untitled", name: null, preview: "", recencyAt: 20}),
        ]});
        closeClient = () => connection.close();

        const response = await connection.agent.request(acpV2.methods.agent.session.list, {cwd});

        expect(response.sessions.map(({sessionId, title}) => [sessionId, title])).toEqual([
            ["named", "Named thread"],
            ["blank-name", `Investigate ${"x".repeat(MAX_SESSION_TITLE_LENGTH)} end`],
            ["summarized", "Summary"],
            ["untitled", null],
        ]);
    });

    it('sends the uncut title of a changed row to a subscription', async () => {
        const name = `Renamed ${"y".repeat(MAX_SESSION_TITLE_LENGTH)}`;
        const {connection, listChanges, sendServerNotification} = await connectV2Client(["sessionIndex"], {
            threadRead: createThread({name, path: "/codex-home/sessions/rollout.jsonl"}),
        });
        closeClient = () => connection.close();

        const {subscriptionId} = await connection.agent.request(SESSION_LIST_SUBSCRIBE_METHOD, {cwd}) as {subscriptionId: string};
        sendServerNotification({method: "thread/name/updated", params: {threadId: sessionId, threadName: name}});

        await vi.waitFor(() => expect(listChanges).toEqual([{
            subscriptionId,
            sessions: [expect.objectContaining({sessionId, title: name})],
            removed: [],
        }]));
    });
});
