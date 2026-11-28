import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {
    SESSION_ALREADY_OPEN_REASON,
    SESSION_READ_METHOD,
} from "../../AcpExtensions";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {threadActiveWriterRequestError} from "../../CodexThreadErrors";
import type {Thread, ThreadItemEntry} from "../../app-server/v2";
import {createTestModel} from "../acp-test-utils";
import {createMockConnections} from "./test-utils";
import {commandExecutionItem} from "./v2-prompt-harness";
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const sessionId = "019c6e27-e55b-73d1-87d8-4e01f1f75043";
const cwd = "/workspace";

function createThread(overrides?: Partial<Thread>): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "First question",
        ephemeral: false,
        modelProvider: "openai",
        model: "model-id",
        reasoningEffort: "medium",
        createdAt: 100,
        updatedAt: 200,
        recencyAt: null,
        status: {type: "active", activeFlags: []},
        path: "/codex/sessions/rollout.jsonl",
        cwd,
        cliVersion: "0.171.0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        source: "vscode",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: "Saved thread title",
        turns: [],
        ...overrides,
    };
}

const sampleEntries: ThreadItemEntry[] = [
    {
        turnId: "019c6e27-0000-7000-8000-000000000001",
        startedAtMs: 1000,
        completedAtMs: 1100,
        item: {
            type: "userMessage",
            id: "u-1",
            clientId: "client-u-1",
            content: [{type: "text", text: "Check src/index.ts", text_elements: []}],
        },
    },
    {
        turnId: "019c6e27-0000-7000-8000-000000000001",
        startedAtMs: 1100,
        completedAtMs: 1200,
        item: {
            type: "reasoning",
            id: "r-1",
            summary: ["Inspecting workspace"],
            content: [],
        },
    },
    {
        turnId: "019c6e27-0000-7000-8000-000000000001",
        startedAtMs: 1200,
        completedAtMs: 1300,
        item: {...commandExecutionItem("cmd-1", "completed"), command: "ls -la", aggregatedOutput: "README.md\n", exitCode: 0},
    },
    {
        turnId: "019c6e27-0000-7000-8000-000000000001",
        startedAtMs: 1300,
        completedAtMs: 1400,
        item: {
            type: "agentMessage",
            id: "a-1",
            text: 'Checked :codex-file-citation{path="src/index.ts" purpose="entry"}.',
            phase: null,
            moderation: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
        },
    },
    {
        turnId: "019c6e27-0000-7000-8000-000000000002",
        startedAtMs: 2000,
        completedAtMs: 2100,
        item: {
            type: "userMessage",
            id: "u-2",
            clientId: "client-u-2",
            content: [{type: "text", text: "Second turn", text_elements: []}],
        },
    },
];

function connectTestRouter() {
    const mocks = createMockConnections();
    const model = createTestModel();
    let appServer!: CodexAppServerClient;
    let server!: CodexAcpServer;
    const router = createAcpAgentRouter((connection, toHttp) => {
        appServer = new CodexAppServerClient(mocks.mockCodexConnection as any);
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        const client = new CodexAcpClient(appServer, undefined, undefined, toHttp);
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        vi.spyOn(client, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
        server = new CodexAcpServer(connection, client);
        return server;
    });
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    return {
        appServer: () => appServer,
        server: () => server,
        clientStream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
    };
}

describe("_session/read", () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    it.each([1, 2] as const)(
        "reads paginated history without thread/resume even when another writer holds the thread (ACP v%i)",
        async protocolVersion => {
            const h = connectTestRouter();
            const v1Updates: acp.SessionNotification[] = [];
            const v2Updates: acpV2.UpdateSessionNotification[] = [];

            let requestRead!: (params: Record<string, unknown>, options?: acp.SendRequestOptions) => Promise<unknown>;
            if (protocolVersion === 1) {
                const conn = acp.client()
                    .onNotification(acp.methods.client.session.update, ({params}) => {
                        v1Updates.push(params);
                    })
                    .connect(h.clientStream);
                closeClient = () => conn.close();
                const init = await conn.agent.request(acp.methods.agent.initialize, {
                    protocolVersion: 1,
                    clientCapabilities: {session: {cursors: {}}},
                });
                expect(init._meta).toMatchObject({sessionRead: {supported: true}});
                requestRead = (params, options) => conn.agent.request(SESSION_READ_METHOD, params, options);
            } else {
                const conn = acpV2.client({name: "test-client"})
                    .onNotification(acpV2.methods.client.session.update, ({params}) => {
                        checkV2SessionUpdate(params.update);
                        v2Updates.push(params);
                    })
                    .connect(h.clientStream);
                closeClient = () => conn.close();
                const init = await conn.agent.request(acpV2.methods.agent.initialize, {
                    protocolVersion: 2,
                    info: {name: "test-client", version: "1.0.0"},
                });
                expect(init._meta).toMatchObject({sessionRead: {supported: true}});
                requestRead = (params, options) => conn.agent.request(SESSION_READ_METHOD, params, options);
            }

            const thread = createThread();
            const appServer = h.appServer();
            appServer.threadResume = vi.fn().mockRejectedValue(
                threadActiveWriterRequestError(sessionId, new Error(`thread ${sessionId} already has an active writer`)),
            );
            appServer.threadRead = vi.fn().mockResolvedValue({thread});
            appServer.threadItemEntryPages = vi.fn(async function* () {
                yield sampleEntries;
            });

            const result = await requestRead({sessionId, cwd: null, _meta: null});
            expect(result).toEqual({});
            expect(appServer.threadResume).not.toHaveBeenCalled();

            if (protocolVersion === 1) {
                const kinds = v1Updates.map(u => u.update.sessionUpdate);
                expect(kinds).toContain("session_info_update");
                expect(kinds).toContain("user_message_chunk");
                expect(kinds).toContain("agent_thought_chunk");
                expect(kinds).toContain("tool_call");
                expect(kinds).toContain("agent_message_chunk");
                expect(kinds).toContain("cursor_update");

                const agentMsg = v1Updates.find(u => u.update.sessionUpdate === "agent_message_chunk");
                expect(agentMsg?.update).toMatchObject({
                    sessionUpdate: "agent_message_chunk",
                    content: {type: "text", text: "Checked [src/index.ts](/workspace/src/index.ts)."},
                });

                const cursor = v1Updates.find(u => u.update.sessionUpdate === "cursor_update");
                expect(cursor?.update).toMatchObject({
                    sessionUpdate: "cursor_update",
                    cursorId: "before:019c6e27-0000-7000-8000-000000000002",
                    capabilities: {fork: {}},
                });
            } else {
                expectConformingV2SessionUpdates();
                const kinds = v2Updates.map(u => u.update.sessionUpdate);
                expect(kinds).toContain("user_message");
                expect(kinds).toContain("agent_thought");
                expect(kinds).toContain("tool_call_update");
                expect(kinds).toContain("agent_message");
                expect(kinds).toContain("cursor_update");
                expect(kinds).toContain("replay_complete");
                expect(kinds).not.toContain("state_update");
            }
        },
    );

    it("leaves no open session state behind so a subsequent session/load succeeds cleanly", async () => {
        const h = connectTestRouter();
        const updates: acp.SessionNotification[] = [];
        const conn = acp.client()
            .onNotification(acp.methods.client.session.update, ({params}) => {
                updates.push(params);
            })
            .connect(h.clientStream);
        closeClient = () => conn.close();

        await conn.agent.request(acp.methods.agent.initialize, {protocolVersion: 1});
        const model = createTestModel();
        const legacyThread = createThread({
            historyMode: "legacy",
            turns: [{
                id: "turn-legacy-1",
                rootTurnId: null,
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
                items: [sampleEntries[0]!.item, sampleEntries[3]!.item],
            }],
        });

        const appServer = h.appServer();
        appServer.threadRead = vi.fn().mockResolvedValue({thread: legacyThread});
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: legacyThread});
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: legacyThread,
            model: model.id,
            modelProvider: "openai",
            cwd,
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });

        await expect(conn.agent.request(SESSION_READ_METHOD, {sessionId, cwd: "/override/root"})).resolves.toEqual({});
        const readAgentChunk = updates.find(u => u.update.sessionUpdate === "agent_message_chunk");
        expect(readAgentChunk?.update).toMatchObject({
            content: {type: "text", text: "Checked [src/index.ts](/override/root/src/index.ts)."},
        });

        updates.length = 0;
        await conn.agent.request(acp.methods.agent.session.load, {sessionId, cwd, mcpServers: []});
        expect(appServer.threadResume).toHaveBeenCalledTimes(1);
        expect(updates.some(u => u.update.sessionUpdate === "agent_message_chunk")).toBe(true);

        // Once the session is open on this connection, _session/read rejects to avoid interleaving updates.
        await expect(conn.agent.request(SESSION_READ_METHOD, {sessionId, cwd})).rejects.toMatchObject({
            code: -32600,
            data: {reason: SESSION_ALREADY_OPEN_REASON, sessionId},
        });
    });

    it.each([
        ["empty sessionId", {sessionId: "   ", cwd}, -32602],
        ["relative cwd", {sessionId, cwd: "relative/path"}, -32602],
        ["unknown session", {sessionId: "missing-session", cwd}, -32002],
    ] as const)("rejects %s (%j) with code %d", async (_label, params, expectedCode) => {
        const h = connectTestRouter();
        const conn = acp.client().connect(h.clientStream);
        closeClient = () => conn.close();
        await conn.agent.request(acp.methods.agent.initialize, {protocolVersion: 1});

        h.appServer().threadRead = vi.fn().mockRejectedValue(new Error("no rollout found for thread id missing-session"));
        await expect(conn.agent.request(SESSION_READ_METHOD, params)).rejects.toMatchObject({code: expectedCode});
    });

    it("stops paging and returns -32800 when the client cancels _session/read", async () => {
        const h = connectTestRouter();
        const conn = acp.client().connect(h.clientStream);
        closeClient = () => conn.close();
        await conn.agent.request(acp.methods.agent.initialize, {protocolVersion: 1});

        const thread = createThread();
        const controller = new AbortController();
        let thirdPageReached = false;
        h.appServer().threadRead = vi.fn().mockResolvedValue({thread});
        h.appServer().threadItemEntryPages = vi.fn(async function* () {
            yield [sampleEntries[0]!];
            controller.abort();
            await new Promise(resolve => setTimeout(resolve, 25));
            yield [sampleEntries[1]!];
            thirdPageReached = true;
            yield [sampleEntries[3]!];
        });

        await expect(
            conn.agent.request(SESSION_READ_METHOD, {sessionId, cwd}, {cancellationSignal: controller.signal}),
        ).rejects.toMatchObject({code: -32800});
        expect(thirdPageReached).toBe(false);
    });
});
