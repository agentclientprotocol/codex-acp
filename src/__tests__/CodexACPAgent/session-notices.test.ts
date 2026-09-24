import type * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it, vi} from "vitest";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import type {ServerNotification} from "../../app-server";
import type {Thread, Turn} from "../../app-server/v2";
import {CodexSubagentEventRouter} from "../../subagents/CodexSubagentEventRouter";
import {
    createCodexMockTestFixture,
    createTestModel,
    createTestSessionState,
    type CodexMockTestFixture,
} from "../acp-test-utils";

const sessionId = "notice-session";
const turnId = "notice-turn";
const childSessionId = "notice-child";
const noticeCapabilities: acp.ClientCapabilities = {session: {notices: {}}};
const airCapabilities = {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}}};

describe("session notices", () => {
    it.each([
        ["empty notice capability", noticeCapabilities],
        ["extended notice capability", {session: {notices: {_meta: {future: true}}}}],
        ["AIR typed failures", {...noticeCapabilities, ...airCapabilities}],
    ])("delivers independent advisory notices with %s", async (_label, capabilities) => {
        const fixture = await createFixture(capabilities);
        await sendNotifications(fixture, advisoryNotifications());

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/session-notices-advisories.json");
    });

    it.each([
        ["omitted capabilities", undefined],
        ["null capabilities", null],
        ["empty capabilities", {}],
        ["null session capabilities", {session: null}],
        ["empty session capabilities", {session: {}}],
        ["array session capabilities", {session: []}],
        ["boolean session capabilities", {session: true}],
        ["null notices", {session: {notices: null}}],
        ["array notices", {session: {notices: []}}],
        ["true notices", {session: {notices: true}}],
        ["false notices", {session: {notices: false}}],
        ["string notices", {session: {notices: "supported"}}],
        ["numeric notices", {session: {notices: 1}}],
    ])("preserves legacy output with %s", async (_label, capabilities) => {
        const fixture = await createFixture(capabilities);
        await sendNotifications(fixture, advisoryNotifications());

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/session-notices-legacy.json");
    });

    it.each([
        ["missing session capabilities", airCapabilities],
        ["null session capabilities", {...airCapabilities, session: null}],
        ["empty session capabilities", {...airCapabilities, session: {}}],
        ["null notices", {...airCapabilities, session: {notices: null}}],
        ["invalid notices", {...airCapabilities, session: {notices: true}}],
    ])("preserves AIR advisory output with %s", async (_label, capabilities) => {
        const fixture = await createFixture(capabilities);
        await sendNotifications(fixture, advisoryNotifications());

        await expect(fixture.getAcpConnectionDump(["args.0.update._meta.jetbrains.air.sessionFailure.id"]))
            .toMatchFileSnapshot("data/session-notices-air-fallback.json");
    });

    it("preserves optional descriptions and supplies nonempty titles for empty upstream text", async () => {
        const fixture = await createFixture(noticeCapabilities);
        await sendNotifications(fixture, [
            {method: "warning", params: {threadId: sessionId, message: " \n "}},
            {method: "configWarning", params: {summary: " \t ", details: null}},
            {method: "deprecationNotice", params: {summary: "", details: null}},
            {method: "configWarning", params: {summary: "Default configuration", details: ""}},
            {method: "deprecationNotice", params: {summary: "Old configuration", details: ""}},
            {method: "warning", params: {threadId: null, message: "  Global warning  "}},
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/session-notices-optional-content.json");
    });

    it("uses the negotiated compaction lifecycle without adding a redundant notice", async () => {
        const fixture = await createFixture({session: {notices: {}, compaction: {}}});
        const item = {type: "contextCompaction" as const, id: "notice-compaction"};
        await sendNotifications(fixture, [
            {method: "item/started", params: {threadId: sessionId, turnId, startedAtMs: 0, item}},
            {method: "item/completed", params: {threadId: sessionId, turnId, completedAtMs: 1, item}},
            {method: "thread/compacted", params: {threadId: sessionId, turnId}},
        ]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/session-notices-compaction-lifecycle.json");
    });

    it("buffers child notices until the child session exists and stops them when it closes", async () => {
        const fixture = await createFixture({
            ...noticeCapabilities,
            _meta: {jetbrains: {air: {version: 1, capabilities: ["nativeSubagentSessions"]}}},
        }, true);
        await sendNotifications(fixture, [{
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId,
                startedAtMs: 0,
                item: {
                    type: "collabAgentToolCall",
                    id: "spawn-notice-child",
                    tool: "spawnAgent",
                    status: "inProgress",
                    senderThreadId: sessionId,
                    receiverThreadIds: [childSessionId],
                    prompt: "Check the delegated task.",
                    model: null,
                    reasoningEffort: null,
                    agentsStates: {[childSessionId]: {status: "running", message: null}},
                },
            },
        }, {
            method: "warning",
            params: {threadId: childSessionId, message: "Child integration unavailable"},
        }, modelRerouted(childSessionId)]);
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        await sendNotifications(fixture, [{
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId,
                startedAtMs: 0,
                item: {
                    type: "subAgentActivity",
                    id: "notice-child-activity",
                    kind: "started",
                    agentThreadId: childSessionId,
                    agentPath: "/root/notice_child",
                },
            },
        }, {
            method: "thread/compacted",
            params: {threadId: childSessionId, turnId: "child-turn"},
        }, {
            method: "warning",
            params: {threadId: sessionId, message: "Root integration unavailable"},
        }, {
            method: "turn/completed",
            params: {threadId: childSessionId, turn: {...createTurn("completed"), id: "child-turn"}},
        }, {
            method: "warning",
            params: {threadId: childSessionId, message: "Late child warning"},
        }]);

        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/session-notices-native-child.json");
    });

    it("keeps live notices out of loaded session history", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const model = createTestModel();
        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(appServer, "listModels").mockResolvedValue({data: [model], nextCursor: null});
        const thread = createThread();
        vi.spyOn(appServer, "threadResume").mockResolvedValue({
            thread,
            model: model.id,
            modelProvider: "openai",
            serviceTier: null,
            cwd: thread.cwd,
            instructionSources: [],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
            disabledPluginIds: [],
            collaborationMode: null,
            turnsBackwardsCursor: null,
            itemsBackwardsCursor: null,
        });
        vi.spyOn(appServer, "threadReadWithHistory").mockResolvedValue({thread});
        mockCompletedPrompt(fixture);
        await agent.initialize({protocolVersion: 1, clientCapabilities: noticeCapabilities});
        const request = {sessionId, cwd: thread.cwd, mcpServers: []};
        await agent.loadSession(request);
        await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue."}]});
        fixture.clearAcpConnectionDump();
        await sendNotifications(fixture, advisoryNotifications());
        expect(fixture.getAcpConnectionEvents([]).filter(event => event.method === "sessionUpdate"
            && event.args[0].update.sessionUpdate === "notice")).toHaveLength(6);

        fixture.clearAcpConnectionDump();
        await agent.loadSession(request);
        const timeline = fixture.getAcpConnectionEvents([]).filter(event => event.method === "sessionUpdate"
            && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "notice"]
                .includes(event.args[0].update.sessionUpdate));
        await expect(JSON.stringify(timeline, null, 2)).toMatchFileSnapshot("data/session-notices-replay.json");

        await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue after loading."}]});
        fixture.clearAcpConnectionDump();
        await sendNotifications(fixture, advisoryNotifications());
        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/session-notices-advisories.json");
    });
});

async function createFixture(clientCapabilities?: unknown, nativeSubagents = false) {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    mockCompletedPrompt(fixture);
    const sessionState = createTestSessionState({sessionId});
    if (nativeSubagents) {
        sessionState.subagents = new CodexSubagentEventRouter(
            sessionId,
            true,
            new ACPSessionConnection(fixture.getAcpConnection(), sessionId),
        );
    }
    vi.spyOn(agent, "getSessionState").mockReturnValue(sessionState);
    // Exercise malformed capability values at the agent boundary as well as valid SDK inputs.
    await agent.initialize({
        protocolVersion: 1,
        ...(clientCapabilities === undefined ? {} : {clientCapabilities: clientCapabilities as acp.ClientCapabilities}),
    });
    await agent.prompt({sessionId, prompt: [{type: "text", text: "Continue."}]});
    fixture.clearAcpConnectionDump();
    return fixture;
}

function mockCompletedPrompt(fixture: CodexMockTestFixture): void {
    const appServer = fixture.getCodexAppServerClient();
    vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: createTurn("inProgress")});
    vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({threadId: sessionId, turn: createTurn("completed")});
}

async function sendNotifications(fixture: CodexMockTestFixture, notifications: ServerNotification[]) {
    for (const notification of notifications) fixture.sendServerNotification(notification);
    await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
}

function advisoryNotifications(): ServerNotification[] {
    return [
        {method: "warning", params: {threadId: sessionId, message: "Optional integration unavailable"}},
        {method: "warning", params: {threadId: sessionId, message: "Optional integration unavailable"}},
        {method: "configWarning", params: {summary: "  Configuration fallback  ", details: "Using the default configuration.\nCheck the configured path."}},
        {method: "deprecationNotice", params: {summary: "  Deprecated setting  ", details: "Use the replacement setting."}},
        modelRerouted(sessionId),
        {method: "thread/compacted", params: {threadId: sessionId, turnId}},
    ];
}

function modelRerouted(threadId: string): ServerNotification {
    return {
        method: "model/rerouted",
        params: {threadId, turnId, fromModel: "original-model", toModel: "fallback-model", reason: "highRiskCyberActivity"},
    };
}

function createTurn(status: Turn["status"]): Turn {
    return {id: turnId, items: [], itemsView: "full", status, error: null, startedAt: null, completedAt: null, durationMs: null};
}

function createThread(): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        originator: null,
        forkedFromId: null,
        preview: "Notice history",
        ephemeral: false,
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 1,
        updatedAt: 2,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd: "/test/cwd",
        cliVersion: "0",
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [{...createTurn("completed"), items: [
            {type: "agentMessage", id: "before-compaction", text: "Before compaction.", phase: null, memoryCitation: null, delivery: null, questions: null},
            {type: "contextCompaction", id: "history-compaction"},
            {type: "agentMessage", id: "after-compaction", text: "After compaction.", phase: null, memoryCitation: null, delivery: null, questions: null},
        ]}],
    };
}
