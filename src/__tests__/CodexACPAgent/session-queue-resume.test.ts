import {describe, expect, it, vi} from "vitest";
import type {LoadSessionRequest} from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {CodexAcpServer, SessionState} from "../../CodexAcpServer";
import {ACPSessionConnection} from "../../ACPSessionConnection";
import {SESSION_QUEUE_ACTIONS} from "../../SessionQueue";
import {TitleGenerator} from "../../TitleGenerator";
import type {Thread, ThreadItem, Turn} from "../../app-server/v2";

const sessionId = "session-id";
const params = {sessionId, cwd: "/test/cwd", mcpServers: []};
const turn = (id: string, status: Turn["status"] = "inProgress"): Turn => ({
    id, status, items: [], itemsView: "notLoaded", error: null,
    startedAt: null, completedAt: null, durationMs: null,
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}

type Metadata = Awaited<ReturnType<CodexAcpServer["getOrCreateSession"]>>;
type HistoryMetadata = {
    sessionId: string;
    modelState: Metadata[1];
    modeState: Metadata[2];
    thread: Thread;
    history: AsyncIterable<ThreadItem[]>;
};
// Only metadata/history boundaries are replaced. Installation and queue routing stay real.
type OpenBoundaries = {
    sessions: Map<string, SessionState>;
    installSessionState(state: SessionState): void;
    getOrCreateSessionWithHistory(request: LoadSessionRequest): Promise<HistoryMetadata>;
    streamThreadHistory(sessionId: string, thread: Thread, history: AsyncIterable<ThreadItem[]>): Promise<void>;
};

function setup() {
    const f = createCodexMockTestFixture();
    const agent = f.getCodexAcpAgent();
    const client = f.getCodexAcpClient();
    const native = f.getCodexAppServerClient();
    client.queueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
    const boundaries = agent as unknown as OpenBoundaries;
    const state = createTestSessionState();
    const metadata: Metadata = [sessionId,
        {currentModelId: state.currentModelId, availableModels: []},
        state.agentMode.toSessionModeState(false),
    ];
    const historyMetadata: HistoryMetadata = {
        sessionId, modelState: metadata[1], modeState: metadata[2],
        // The history boundary below is stubbed; no production code consumes this thread.
        thread: {id: sessionId} as Thread,
        history: (async function* () {})(),
    };
    const send = (method: string, values: object = {}) =>
        f.sendServerNotification({method, params: {threadId: sessionId, ...values}});
    const emit = async (method: string, values: object = {}) => {
        send(method, values);
        await client.waitForSessionNotifications(sessionId);
    };
    const events = () => f.getAcpConnectionEvents([]);
    const text = () => events().filter(event => event.method === "sessionUpdate"
        && event.args[0].update.sessionUpdate === "agent_message_chunk")
        .map(event => event.args[0].update.content.text);
    const approval = (id: string) => f.sendServerRequest("item/commandExecution/requestApproval", {
        threadId: sessionId, turnId: id, itemId: `cmd-${id}`, approvalId: null,
        kind: "command", startedAtMs: 0, environmentId: null,
        command: `echo ${id}`, cwd: params.cwd, availableDecisions: ["accept", "decline"],
    });
    f.setPermissionResponse({outcome: {outcome: "selected", optionId: "allow_once"}});
    const early = (id: string) => {
        send("turn/started", {turn: turn(id)});
        send("item/agentMessage/delta", {turnId: id, itemId: `answer-${id}`, delta: `live ${id}`});
        let settled = false;
        const response = approval(id).then(value => { settled = true; return value; });
        return {response, settled: () => settled};
    };
    const stubResume = (install: () => Promise<void>) => vi.spyOn(agent, "getOrCreateSession")
        .mockImplementation(async () => { await install(); return metadata; });
    const stubLoad = (install: () => Promise<void>) => vi.spyOn(boundaries, "getOrCreateSessionWithHistory")
        .mockImplementation(async () => { await install(); return historyMetadata; });
    return {f, agent, client, native, boundaries, state, send, emit, events, text, approval, early, stubResume, stubLoad};
}

// Advance runnable promise continuations, without wall-clock sleeps or awaiting the blocked queue.
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

describe("native queue resume and history buffering", () => {
    it("buffers native start, output and approval before resume installs SessionState", async () => {
        const h = setup();
        const entered = deferred<void>();
        const install = deferred<void>();
        h.stubResume(async () => {
            entered.resolve();
            await install.promise;
            h.boundaries.installSessionState(h.state);
        });
        const resumed = h.agent.resumeSession(params);
        await entered.promise;
        const pending = h.early("resume");
        try {
            await checkpoint();
            expect(h.boundaries.sessions.has(sessionId)).toBe(false);
            expect(pending.settled()).toBe(false);
            expect(h.events()).toEqual([]);
        } finally {
            install.resolve();
            await resumed;
        }
        try {
            await h.client.waitForSessionNotifications(sessionId);
            expect(await pending.response).toEqual({decision: "accept"});
            expect(h.state.currentTurnId).toBe("resume");
            expect(h.text()).toEqual(["live resume"]);
            expect(h.events().filter(event => event.method === "requestPermission")).toHaveLength(1);
        } finally {
            await h.emit("turn/completed", {turn: turn("resume", "completed")});
        }
    });

    it.each([false, true])("keeps live events behind history replay and previous title settlement (reload=%s)", async reload => {
        const h = setup();
        const entered = deferred<void>();
        const install = deferred<void>();
        const replayEntered = deferred<void>();
        const replay = deferred<void>();
        const titleEntered = deferred<void>();
        const title = deferred<void>();
        if (reload) {
            const previous = createTestSessionState();
            previous.titleGen = new TitleGenerator(h.native, sessionId, params.cwd, () => "unknown");
            vi.spyOn(previous.titleGen, "waitForIdle").mockImplementation(async () => {
                titleEntered.resolve();
                await title.promise;
            });
            // A reload must replace the already-ready owner from the preceding open.
            h.boundaries.installSessionState(previous);
            await checkpoint();
        }
        h.stubLoad(async () => {
            entered.resolve();
            await install.promise;
            h.boundaries.installSessionState(h.state);
        });
        vi.spyOn(h.boundaries, "streamThreadHistory").mockImplementation(async () => {
            replayEntered.resolve();
            await replay.promise;
            await new ACPSessionConnection(h.f.getAcpConnection(), sessionId).update({
                sessionUpdate: "agent_message_chunk", content: {type: "text", text: "history replay"},
            });
        });
        const loaded = h.agent.loadSession(params);
        await entered.promise;
        const pending = h.early("load");
        try {
            await checkpoint();
            expect(h.boundaries.sessions.get(sessionId)).not.toBe(h.state);
            expect(h.events()).toEqual([]);
            expect(pending.settled()).toBe(false);
            install.resolve();
            await replayEntered.promise;
            await checkpoint();
            expect(h.boundaries.sessions.get(sessionId)).toBe(h.state);
            expect(h.events()).toEqual([]);
            expect(pending.settled()).toBe(false);
            replay.resolve();
            if (reload) {
                await titleEntered.promise;
                await checkpoint();
                expect(h.text()).toEqual(["history replay"]);
                expect(pending.settled()).toBe(false);
            }
        } finally {
            install.resolve();
            replay.resolve();
            title.resolve();
            await loaded;
        }
        try {
            await h.client.waitForSessionNotifications(sessionId);
            expect(await pending.response).toEqual({decision: "accept"});
            expect(h.text()).toEqual(["history replay", "live load"]);
            expect(h.events().filter(event => event.method === "requestPermission")).toHaveLength(1);
        } finally {
            await h.emit("turn/completed", {turn: turn("load", "completed")});
        }
    });

    it.each(["resume metadata", "load metadata", "load history"] as const)(
        "releases buffered waits after failed %s and replaces failed routing on retry",
        async stage => {
            const h = setup();
            const entered = deferred<void>();
            const fail = deferred<void>();
            const failure = new Error(`failed ${stage}`);
            const reject = async () => { entered.resolve(); await fail.promise; throw failure; };
            if (stage === "resume metadata") h.stubResume(reject);
            else if (stage === "load metadata") h.stubLoad(reject);
            else {
                h.stubLoad(async () => { h.boundaries.installSessionState(h.state); });
                vi.spyOn(h.boundaries, "streamThreadHistory").mockImplementation(reject);
            }
            const opening = stage === "resume metadata" ? h.agent.resumeSession(params) : h.agent.loadSession(params);
            // Observe rejection immediately so a cleanup failure cannot become an unhandled rejection.
            const result = opening.then(() => null, error => error);
            await entered.promise;
            const pending = h.early("failed");
            try {
                await checkpoint();
                expect(pending.settled()).toBe(false);
                expect(h.events()).toEqual([]);
            } finally {
                fail.resolve();
            }
            expect(await result).toBe(failure);
            await h.client.waitForSessionNotifications(sessionId);
            expect(await pending.response).toEqual({decision: "cancel"});
            expect(h.boundaries.sessions.has(sessionId)).toBe(false);
            await h.emit("turn/started", {turn: turn("orphan")});
            await h.emit("item/agentMessage/delta", {turnId: "orphan", itemId: "orphan", delta: "orphan output"});
            expect(await h.approval("orphan")).toEqual({decision: "cancel"});
            expect(h.events()).toEqual([]);

            const retryState = createTestSessionState();
            h.stubResume(async () => { h.boundaries.installSessionState(retryState); });
            await h.agent.resumeSession(params);
            const retry = h.early("retry");
            try {
                await h.client.waitForSessionNotifications(sessionId);
                expect(await retry.response).toEqual({decision: "accept"});
                expect(h.text()).toEqual(["live retry"]);
                expect(retryState.currentTurnId).toBe("retry");
                expect(h.events().filter(event => event.method === "requestPermission")).toHaveLength(1);
            } finally {
                await h.emit("turn/completed", {turn: turn("retry", "completed")});
            }
        },
    );
});
