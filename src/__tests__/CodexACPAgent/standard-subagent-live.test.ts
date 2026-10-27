import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";
import {
    agentMessageDelta, commandExecutionItem, connectSession, codexResponse, createThread, createTurn, cwd,
    itemStarted, sessionId, turnStarted, turnCompleted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";
import {subagentProtocol} from "../../subagents/AcpSubagents";
import {AIR_NATIVE_SUBAGENT_SESSIONS_KEY, withAirMeta} from "../../AirExtension";
import {GOAL_CONTROL_METHOD, SESSION_STEERING_METHOD, LEGACY_SET_SESSION_MODEL_METHOD} from "../../AcpExtensions";
import {SESSION_RENAME_METHOD, SESSION_ARCHIVE_METHOD, SESSION_UNARCHIVE_METHOD} from "../../SessionIndex";
import {ASYNC_TASK_STOP_METHOD} from "../../async-tasks/AsyncTaskExtension";

const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;
const activityItem = (id = worker, path = "/root/worker"): Extract<ThreadItem, {type: "subAgentActivity"}> =>
    ({type: "subAgentActivity", model: null, reasoningEffort: null, id: `activity-${id}`,
        agentThreadId: id, agentPath: path, kind: "started"});
const onWorker = (event: ServerNotification, id = worker): ServerNotification =>
    ({...event, params: {...event.params, threadId: id}} as ServerNotification);

async function flush(h: PromptSession) {
    await h.waitForNotifications();
    await h.request("session/list", {});
}

function history(h: PromptSession, items: ThreadItem[] = [], parent: string | null = sessionId, loaded = true) {
    const resumes: string[] = [];
    const thread = (id: string) => ({...createThread(), id,
        parentThreadId: id === worker ? parent : null,
        status: id === worker && !loaded ? {type: "notLoaded" as const} : {type: "idle" as const}});
    h.setCodexResponse("thread/resume", async params => {
        const id = (params as {threadId: string}).threadId;
        resumes.push(id);
        return {...codexResponse("thread/start") as object, thread: thread(id)};
    });
    h.setCodexResponse("thread/read", async params => {
        const id = (params as {threadId: string}).threadId;
        return {thread: {...thread(id), turns: id === sessionId
            ? [{...createTurn("completed"), itemsView: "full", items}] : []}};
    });
    return resumes;
}

it("selects standard and AIR contracts independently", () => {
    const air = {_meta: withAirMeta(undefined, "capabilities", [AIR_NATIVE_SUBAGENT_SESSIONS_KEY])};
    expect([subagentProtocol(null, 1), subagentProtocol({subagents: {}}, 1), subagentProtocol(null, 2),
        subagentProtocol(air, 1), subagentProtocol(air, 2)]).toEqual(["hidden", "standard", "standard", "air", "air"]);
});

describe.each([1, 2] as const)("ACP v%s live standard subagents", version => {
    let h: PromptSession;
    afterEach(async () => {
        if (h) { await flush(h); h.connection.close(); }
        expectConformingV2SessionUpdates();
    });
    async function connect(options: Parameters<typeof connectSession>[1] = {}) {
        h = await connectSession(version, {v1ClientCapabilities: {subagents: {}}, ...options});
    }
    const load = () => h.request(version === 1 ? "session/load" : "session/resume", {
        sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
    });
    const childUpdates = () => h.scopedUpdates.filter(entry =>
        entry.sessionId.includes(":subagent:") || entry.update.sessionUpdate === "subagent_update");
    async function snapshot(name: string) {
        await flush(h);
        await expect(JSON.stringify(childUpdates(), null, 2)).toMatchFileSnapshot(`data/live-core-v${version}-${name}.json`);
    }
    const approval = (itemId: string, turnId = "child-turn") => h.triggerApproval("item/commandExecution/requestApproval", {
        threadId: worker, turnId, itemId, command: "echo hello", cwd, commandActions: [],
        reason: null, availableDecisions: ["accept", "decline"],
    });

    it("preserves a child identity across idle and later work without publishing agent input as human input", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(onWorker(itemStarted(userMessageItem(null, "Agent delegation"), "child-turn")));
        h.emit(onWorker(agentMessageDelta("First answer", "child-turn", "first")));
        h.emit(onWorker(turnCompleted("child-turn")));
        h.emit(onWorker(turnStarted("next-turn")));
        h.emit(onWorker(agentMessageDelta("Second answer", "next-turn", "second")));
        h.emit(onWorker(turnCompleted("next-turn")));
        await snapshot("identity");
        expect(childUpdates().filter(entry => entry.update.sessionUpdate === "subagent_update"
            && entry.update.capabilities != null && Object.keys(entry.update.capabilities).length === 0)).toHaveLength(1);
        expect(childUpdates().some(entry => entry.update.sessionUpdate === "user_message_chunk")).toBe(false);
    });

    it("waits for immediate parentage and announces ancestors before child traffic", async () => {
        await connect();
        h.emit(itemStarted(activityItem(worker, "/root/coordinator/worker")));
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(onWorker(agentMessageDelta("Nested answer", "child-turn", "nested")));
        await flush(h);
        expect(childUpdates()).toEqual([]);
        h.emit(itemStarted(activityItem("coordinator", "/root/coordinator")));
        await snapshot("nested");
        const known = new Set([sessionId]);
        for (const entry of childUpdates()) {
            expect(known.has(entry.sessionId)).toBe(true);
            if (entry.update.sessionUpdate === "subagent_update" && typeof entry.update.sessionId === "string") known.add(entry.update.sessionId);
        }
    });

    it("rejects all child mutations and raw-provider-ID bypasses", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        await flush(h);
        const methods: Array<[string, Record<string, unknown>]> = [
            ["session/prompt", {prompt: [{type: "text", text: "No"}]}],
            ["session/close", {}], ["session/delete", {}], ["session/fork", {cwd, mcpServers: []}],
            ["session/set_config_option", {configId: "model", value: "gpt-5", ...(version === 2 ? {type: "id"} : {})}],
            ["session/resume", {cwd, mcpServers: []}],
            [SESSION_RENAME_METHOD, {title: "No"}], [SESSION_ARCHIVE_METHOD, {}], [SESSION_UNARCHIVE_METHOD, {}],
            [SESSION_STEERING_METHOD, {prompt: [{type: "text", text: "No"}]}],
            [GOAL_CONTROL_METHOD, {action: "clear"}], [ASYNC_TASK_STOP_METHOD, {asyncTaskId: "task"}],
        ];
        if (version === 1) methods.push(["session/load", {cwd, mcpServers: []}], ["session/set_mode", {modeId: "agent"}],
            [LEGACY_SET_SESSION_MODEL_METHOD, {modelId: "gpt-5"}]);
        for (const id of [childId, worker]) for (const [method, params] of methods) {
            await expect(h.request(method, {sessionId: id, ...params}), `${method}: ${id}`).rejects.toMatchObject({code: -32600});
        }
        await h.agent.cancel({sessionId: childId});
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it("keeps permissions and accepted URL completions alive across parent replay", async () => {
        await connect({
            v1ClientCapabilities: {subagents: {}, elicitation: {url: {}}},
            clientCapabilities: {elicitation: {url: {}}},
            onRequestPermission: async request => ({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}}),
            onElicitation: async () => ({action: "accept", content: null}),
        });
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        expect(await approval("before")).toEqual({decision: "accept"});
        expect(await h.triggerApproval("mcpServer/elicitation/request", {
            threadId: worker, turnId: "child-turn", serverName: "auth", mode: "url", _meta: null,
            message: "Authorize", url: "https://example.com/authorize", elicitationId: "authorization",
        })).toMatchObject({action: "accept"});
        history(h);
        await load();
        expect(await approval("after")).toEqual({decision: "accept"});
        h.emit({method: "serverRequest/resolved", params: {threadId: worker, requestId: "authorization-request"}});
        await flush(h);
        expect(h.transcript).toContainEqual({elicitationComplete: {elicitationId: "authorization"}});
        expect(h.transcript.filter(entry => "permissionRequest" in entry).map(entry =>
            "permissionRequest" in entry ? entry.permissionRequest.sessionId : null)).toEqual([childId, childId]);
    });

    it("withdraws obsolete requests locally even if the client returns an accepted late reply", async () => {
        let accept!: () => void;
        await connect({onRequestPermission: request => new Promise(resolve => {
            accept = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
        })});
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        const pending = approval("late");
        await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
        h.emit(onWorker(turnCompleted("child-turn")));
        await expect(pending).resolves.toEqual({decision: "cancel"});
        accept();
    });

    it("retains blocked work when a new child turn requests approval during parent replay", async () => {
        let answer!: () => void;
        await connect({onRequestPermission: request => new Promise(resolve => {
            answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
        })});
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("old-turn")));
        await flush(h);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reading = false;
        history(h);
        const delay = async <T>(operation: Promise<T>) => {
            const result = await operation;
            reading = true;
            await held;
            return result;
        };
        if (version === 1) {
            const operation = h.agent.loadSession.bind(h.agent);
            vi.spyOn(h.agent, "loadSession").mockImplementation(params => delay(operation(params)));
        } else {
            const operation = h.agent.resumeSessionV2.bind(h.agent);
            vi.spyOn(h.agent, "resumeSessionV2").mockImplementation(params => delay(operation(params)));
        }
        const replay = load();
        void replay.catch(() => {});
        try {
            await vi.waitFor(() => expect(reading).toBe(true));
            h.emit(onWorker(turnStarted("new-turn")));
            const pending = approval("during-replay", "new-turn");
            await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
            release();
            await replay;
            await vi.waitFor(() => {
                const latest = childUpdates().flatMap(entry => {
                    if (version === 2 && entry.sessionId === childId && entry.update.sessionUpdate === "state_update") return [entry.update.state];
                    if (version === 1 && entry.update.sessionUpdate === "subagent_update"
                        && entry.update.state && typeof entry.update.state === "object") return [(entry.update.state as {state: string}).state];
                    return [];
                }).at(-1);
                expect(latest).toBe("requires_action");
            });
            answer();
            await expect(pending).resolves.toEqual({decision: "accept"});
        } finally { release(); answer?.(); }
    });

    it.each([sessionId, "another-root", null] as const)("restores only verified runtime children (parent: %s)", async parent => {
        await connect({onRequestPermission: request => ({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}})});
        const resumes = history(h, [activityItem()], parent);
        await load();
        await flush(h);
        expect(resumes).toEqual(parent === sessionId ? [sessionId, worker] : [sessionId]);
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        if (parent === sessionId) expect(await approval("restored")).toEqual({decision: "accept"});
        else expect(await approval("foreign")).toEqual({decision: "cancel"});
        await snapshot(`ownership-${parent === sessionId ? "owned" : "foreign"}`);
    });

    it("keeps command rendering across parent attachment changes", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(onWorker(itemStarted(commandExecutionItem("terminal"), "child-turn")));
        await flush(h);
        history(h);
        await load();
        h.emit({method: "item/commandExecution/outputDelta", params: {threadId: worker, turnId: "child-turn", itemId: "terminal", delta: "Still streaming"}});
        h.emit({method: "item/completed", params: {threadId: worker, turnId: "child-turn", completedAtMs: 0,
            item: {...commandExecutionItem("terminal", "completed"), exitCode: 0, aggregatedOutput: "Still streaming"}}});
        await snapshot("terminal");
    });

    it("delivers a previously inactive owned child's next turn without another spawn", async () => {
        await connect();
        const resumes = history(h, [activityItem()], sessionId, false);
        await load();
        await flush(h);
        expect(resumes).toEqual([sessionId]);
        h.emit(onWorker(turnStarted("awakened")));
        h.emit(onWorker(agentMessageDelta("Awake", "awakened", "awake")));
        await flush(h);
        expect(childUpdates().some(entry => entry.sessionId === childId
            && entry.update.sessionUpdate === "agent_message_chunk" && entry.update.messageId === "awake")).toBe(true);
    });

    it("tracks a restored child's approval even when its turn started before attachment", async () => {
        let answer!: () => void;
        await connect({onRequestPermission: request => new Promise(resolve => {
            answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
        })});
        history(h, [activityItem()]);
        await load();
        await flush(h);
        const pending = approval("restored-without-start", "already-running");
        try {
            await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
            await flush(h);
            expect(childUpdates().some(entry => entry.update.sessionUpdate === "subagent_update"
                && entry.update.state && typeof entry.update.state === "object"
                && (entry.update.state as {state: string}).state === "requires_action")).toBe(true);
            answer();
            await expect(pending).resolves.toEqual({decision: "accept"});
        } finally { answer?.(); }
    });

    it("restricts raw child IDs before a backpressured announcement is published", async () => {
        await connect();
        const client = h.agent["codexAcpClient"];
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const blocked = client.enqueueSessionTransition(sessionId, () => held);
        try {
            h.emit(itemStarted(activityItem()));
            await expect(h.request("session/close", {sessionId: worker})).rejects.toMatchObject({code: -32600});
            expect(childUpdates()).toEqual([]);
        } finally { release(); }
        await blocked;
        await flush(h);
    });

    it("cascades parent cancellation without inventing a child ending", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        const before = childUpdates().length;
        await h.cancel();
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toContainEqual({threadId: worker, turnId: "child-turn"}));
        await flush(h);
        expect(childUpdates().slice(before)).toEqual([]);
        h.emit(onWorker(turnCompleted("child-turn")));
        await snapshot("cancel");
    });

    it("keeps lost observability unknown when an old completion is repeated", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("old-turn")));
        h.emit(onWorker(turnCompleted("old-turn")));
        h.emit(onWorker(turnStarted("new-turn")));
        h.emit({method: "thread/status/changed", params: {threadId: worker, status: {type: "notLoaded"}}});
        await flush(h);
        const boundary = childUpdates().length;
        h.emit(onWorker(turnCompleted("old-turn")));
        await flush(h);
        expect(childUpdates().slice(boundary)).toEqual([]);
        await snapshot("unknown");
    });

    it("keeps observed models read-only and child-scoped using the existing model reporter", async () => {
        await connect();
        const parent = h.agent.getSessionState(sessionId).currentModelId;
        h.emit(itemStarted({...activityItem(), model: "actual-child-model"}));
        await flush(h);
        const config = childUpdates().find(entry => entry.sessionId === childId && entry.update.sessionUpdate === "config_option_update");
        expect(config).toBeDefined();
        expect(h.agent.getSessionState(sessionId).currentModelId).toBe(parent);
        await snapshot("model");
    });

    it("announces with the latest observed settings model without replaying older buffered settings", async () => {
        await connect();
        h.emit(itemStarted({...activityItem(worker, "/root/coordinator/worker"), model: "activity-model"}));
        const settings = (model: string) => ({
            disabledPluginIds: [], cwd, approvalPolicy: "on-request" as const, approvalsReviewer: "user" as const,
            sandboxPolicy: {type: "readOnly" as const, networkAccess: false}, activePermissionProfile: null,
            model, modelProvider: "test", serviceTier: null, effort: null, summary: null, personality: null,
            collaborationMode: {mode: "default" as const, settings: {model, reasoning_effort: null, developer_instructions: null}},
        });
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("older-settings")}});
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("latest-settings")}});
        await flush(h);
        expect(childUpdates()).toEqual([]);
        h.emit(itemStarted(activityItem("coordinator", "/root/coordinator")));
        await flush(h);
        const options = childUpdates().flatMap(entry => entry.sessionId === childId && entry.update.sessionUpdate === "config_option_update"
            ? [(entry.update as {configOptions: Array<{currentValue: string}>}).configOptions[0]!.currentValue] : []);
        expect(options).toEqual(["latest-settings"]);
    });

    it("replays parent history and empty child associations without inventing a gap or current runtime", async () => {
        await connect();
        const item: ThreadItem = {type: "agentMessage", id: "parent-answer", text: "Parent history", phase: null,
            memoryCitation: null, delivery: null, questions: null};
        history(h, [activityItem(), item], "foreign-root");
        await load();
        await flush(h);
        expect(h.scopedUpdates.some(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === "agent_message_chunk"
            && entry.update.messageId === "parent-answer")).toBe(true);
        expect(h.scopedUpdates.some(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === "agent_thought_chunk"
            && entry.update.messageId === `${sessionId}:subagent-history-gap`)).toBe(false);
        expect(childUpdates().filter(entry => entry.sessionId === childId)).toEqual([]);
    });

    it.skipIf(version !== 2)("finishes two same-parent setups in one batch without deadlock", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        history(h, [activityItem()]);
        await h.requestBatch([
            {method: "session/resume", params: {sessionId, cwd, replayFrom: {type: "start"}}},
            {method: "session/resume", params: {sessionId, cwd, replayFrom: {type: "start"}}},
        ]);
        h.emit(onWorker(agentMessageDelta("Across batch", "child-turn", "batch-output")));
        await flush(h);
        expect(childUpdates().filter(entry => entry.update.sessionUpdate === "agent_message_chunk"
            && entry.update.messageId === "batch-output")).toHaveLength(1);
    });

    it("does not let a queued attachment reopen a parent closed during replay", async () => {
        await connect();
        history(h);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reading = false;
        h.setCodexResponse("thread/read", async params => {
            const {threadId, includeTurns} = params as {threadId: string; includeTurns?: boolean};
            if (includeTurns) { reading = true; await held; }
            return {thread: {...createThread(), id: threadId, turns: []}};
        });
        const first = load();
        void first.catch(() => {});
        try {
            await vi.waitFor(() => expect(reading).toBe(true));
            const second = load();
            void second.catch(() => {});
            await h.request("session/close", {sessionId});
            release();
            await expect(first).rejects.toMatchObject({code: -32600});
            await expect(second).rejects.toMatchObject({code: -32600});
        } finally { release(); }
    });

    it.skipIf(version !== 2)("holds current snapshots until the complete response batch is written", async () => {
        await connect();
        h.emit(itemStarted(activityItem()));
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        history(h);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const list = vi.spyOn(h.agent, "listSessions").mockImplementationOnce(async () => { await held; return {sessions: []}; });
        const resume = vi.spyOn(h.agent, "resumeSessionV2");
        const start = h.wireMessages.length;
        const before = childUpdates().length;
        const batch = h.requestBatch([
            {method: "session/resume", params: {sessionId, cwd, replayFrom: {type: "start"}}},
            {method: "session/list", params: {}},
        ]);
        void batch.catch(() => {});
        try {
            await vi.waitFor(() => expect(resume.mock.results).toHaveLength(1));
            await resume.mock.results[0]!.value;
            expect(list).toHaveBeenCalled();
            await flush(h);
            expect(h.wireMessages.slice(start).some(Array.isArray)).toBe(false);
            expect(childUpdates().slice(before).some(entry => entry.update.sessionUpdate === "state_update")).toBe(false);
        } finally { release(); }
        await batch;
        await flush(h);
        const frames = h.wireMessages.slice(start);
        const response = frames.findIndex(Array.isArray);
        const state = frames.findIndex(frame => !Array.isArray(frame) && "method" in frame && frame.method === "session/update"
            && (frame.params as {sessionId: string; update: {sessionUpdate: string}}).sessionId === childId
            && (frame.params as {update: {sessionUpdate: string}}).update.sessionUpdate === "state_update");
        expect(response).toBeGreaterThanOrEqual(0);
        expect(state).toBeGreaterThan(response);
    });
});
