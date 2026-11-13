import {afterEach, describe, expect, it, vi} from "vitest";
import type {StateUpdate} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem, Turn, TurnStatus} from "../../app-server/v2";
import {
    connectSession, createThread, createTurn, cwd, itemStarted, sessionId, turnCompleted, turnStarted, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;
const spawn: ThreadItem = {type: "subAgentActivity", id: "spawn", kind: "started",
    agentThreadId: worker, agentPath: "/root/worker", model: null, reasoningEffort: null};
const answer: ThreadItem = {type: "agentMessage", id: "retained", text: "Retained answer",
    phase: null, memoryCitation: null, delivery: null, questions: null};
const onWorker = (event: ServerNotification): ServerNotification =>
    ({...event, params: {...event.params, threadId: worker}} as ServerNotification);

async function flush(h: PromptSession) { await h.waitForNotifications(); await h.request("session/list", {}); }
function recordedTurn(status: TurnStatus, id = "recorded"): Turn {
    return {...createTurn(status, id), items: [answer], itemsView: "full",
        error: status === "failed" ? {message: "Recorded failure", codexErrorInfo: null,
            additionalDetails: "Private backend diagnostic", misalignment: null} : null};
}

describe.each([1, 2] as const)("ACP v%s historical child outcomes", version => {
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
    const states = () => h.scopedUpdates.flatMap(entry => entry.update.sessionUpdate === "subagent_update"
        && entry.update.sessionId === childId && entry.update.state != null ? [entry.update.state as StateUpdate] : []);
    const stateUpdates = () => h.scopedUpdates.filter(entry => entry.update.sessionUpdate === "subagent_update"
        && entry.update.sessionId === childId && entry.update.state != null
        || entry.sessionId === childId && entry.update.sessionUpdate === "state_update");
    const gap = () => h.scopedUpdates.some(entry => entry.update.sessionUpdate === "agent_thought_chunk"
        && entry.update.messageId === `${sessionId}:subagent-history-gap`);

    function history(turns: Turn[], paginated = false) {
        const reads: Array<{threadId: string; includeTurns?: boolean}> = [];
        h.setCodexResponse("thread/read", async params => {
            const request = params as {threadId: string; includeTurns?: boolean};
            reads.push(request);
            return {thread: {...createThread(), id: request.threadId, status: {type: "notLoaded"},
                parentThreadId: request.threadId === worker ? "foreign-root" : null,
                historyMode: request.threadId === worker && paginated ? "paginated" : "legacy",
                turns: request.threadId === worker ? request.includeTurns ? turns : []
                    : [{...createTurn("completed"), itemsView: "full", items: [spawn]}]}};
        });
        const summaries = vi.fn(async () => ({
            data: turns.length ? [{...turns.at(-1)!, items: [], itemsView: "notLoaded"}] : [],
            nextCursor: null, backwardsCursor: null,
        }));
        h.setCodexResponse("thread/turns/list", summaries);
        h.setCodexResponse("thread/items/list", async () => ({
            data: turns.flatMap(turn => turn.items.map(item => ({item, turnId: turn.id, startedAtMs: 0,
                completedAtMs: turn.status === "inProgress" ? null : 1}))), nextCursor: null, backwardsCursor: null,
        }));
        return {reads, summaries};
    }

    it.each(([false, true]).flatMap(paginated =>
        (["completed", "interrupted", "failed", "inProgress", "missing"] as const).map(status => ({paginated, status})),
    ))("replays only a known final outcome before the response ($status, paginated: $paginated)", async ({status, paginated}) => {
        await connect();
        const {reads, summaries} = history(status === "missing" ? [] : [recordedTurn(status)], paginated);
        const start = h.wireMessages.length;
        await load();
        const boundary = h.scopedUpdates.length;
        await flush(h);
        expect(h.scopedUpdates.slice(boundary).filter(entry => entry.sessionId === childId
            || entry.update.sessionUpdate === "subagent_update")).toEqual([]);
        expect(h.turnInterruptCalls()).toEqual([]);
        await expect(h.request("session/set_config_option", {sessionId: childId, configId: "model", value: "anything",
            ...(version === 2 ? {type: "id"} : {})})).rejects.toMatchObject({code: -32600});
        const final = status !== "missing" && status !== "inProgress";
        expect(states()).toHaveLength(final ? 1 : 0);
        if (final) {
            await expect(JSON.stringify(stateUpdates(), null, 2))
                .toMatchFileSnapshot(`data/historical-outcome-v${version}-${status}.json`);
            const frames = h.wireMessages.slice(start).flatMap(frame => Array.isArray(frame) ? frame : [frame]);
            const response = frames.findIndex(frame => "result" in frame && frame.result !== null
                && typeof frame.result === "object" && "configOptions" in frame.result);
            const outcome = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
                && (frame.params as {update: {state?: {state: string}}}).update.state?.state === "idle");
            expect(outcome).toBeGreaterThanOrEqual(0);
            expect(response).toBeGreaterThan(outcome);
        }
        expect(JSON.stringify(h.scopedUpdates)).not.toContain("Private backend diagnostic");
        if (paginated) {
            expect(summaries).toHaveBeenCalledExactlyOnceWith({threadId: worker, limit: 1, sortDirection: "desc", itemsView: "notLoaded"});
            expect(reads.some(read => read.threadId === worker && read.includeTurns)).toBe(false);
        } else {
            expect(summaries).not.toHaveBeenCalled();
            expect(reads.filter(read => read.threadId === worker && read.includeTurns)).toHaveLength(1);
        }
    });

    it.each(["completed", "inProgress"] as const)("does not substitute an older outcome for the latest %s turn", async status => {
        await connect();
        history([recordedTurn("failed", "older"), recordedTurn(status, "latest")]);
        await load();
        await flush(h);
        expect(states()).toEqual(status === "completed" ? [{state: "idle", stopReason: "end_turn"}] : []);
    });

    it("retains paginated transcripts and reports a gap when outcome summaries are unavailable", async () => {
        await connect();
        history([recordedTurn("completed")], true);
        h.setCodexResponse("thread/turns/list", async () => { throw new Error("Private outcome lookup diagnostic"); });
        await load();
        await flush(h);
        expect(states()).toEqual([]);
        expect(h.scopedUpdates.some(entry => entry.sessionId === childId && entry.update.sessionUpdate === "agent_message_chunk"
            && entry.update.messageId === "retained")).toBe(true);
        expect(gap()).toBe(true);
        expect(JSON.stringify(h.scopedUpdates)).not.toContain("Private outcome lookup diagnostic");
    });

    it("does not turn a replayed failure into current foreground state on the next resume", async () => {
        await connect();
        history([recordedTurn("failed")]);
        await load();
        await flush(h);
        expect(states()).toHaveLength(1);
        const before = states().length;
        await h.request("session/resume", {sessionId, cwd, mcpServers: []});
        await flush(h);
        expect(states().slice(before)).toEqual([]);
        await h.cancel();
        await flush(h);
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it("keeps a newer live permission and foreground state independent of a recorded ending", async () => {
        let answerPermission!: () => void;
        await connect({onRequestPermission: request => new Promise(resolve => {
            answerPermission = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
        })});
        h.emit(itemStarted(spawn));
        h.emit(onWorker(turnStarted("live-turn")));
        await flush(h);
        const pending = h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: worker, turnId: "live-turn", itemId: "waiting", command: "echo next", cwd,
            commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        });
        try {
            await vi.waitFor(() => expect(answerPermission).toBeTypeOf("function"));
            history([recordedTurn("failed")]);
            const before = states().length;
            await load();
            await vi.waitFor(() => expect(states().at(-1)).toMatchObject({state: "requires_action"}));
            expect(states().slice(before).some(state => state.state === "idle" && state.stopReason === "error")).toBe(true);
            answerPermission();
            await expect(pending).resolves.toEqual({decision: "accept"});
            h.emit(onWorker(turnCompleted("live-turn")));
            await vi.waitFor(() => expect(states().at(-1)).toEqual({state: "idle", stopReason: "end_turn"}));
        } finally { answerPermission?.(); }
    });

    it("preserves nested parentage and emits each child's outcome once across repeated spawn records", async () => {
        await connect();
        history([]);
        const coordinatorId = `${sessionId}:subagent:coordinator`;
        const collaboration: ThreadItem = {type: "collabAgentToolCall", id: "legacy-spawn", tool: "spawnAgent", status: "completed",
            senderThreadId: "coordinator", receiverThreadIds: [worker], prompt: null, model: null, reasoningEffort: null, agentsStates: {}};
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            return {thread: {...createThread(), id, status: {type: "notLoaded"}, parentThreadId: "foreign-root",
                turns: id === sessionId ? [{...createTurn("completed"), itemsView: "full", items: [
                    {...spawn, agentThreadId: "coordinator", agentPath: "/root/coordinator"},
                    {...collaboration, senderThreadId: sessionId},
                ]}] : id === "coordinator" ? [{...createTurn("completed"), itemsView: "full", items: [collaboration]}]
                    : [recordedTurn("interrupted")]}};
        });
        await load();
        await flush(h);
        const outcomes = h.scopedUpdates.flatMap(entry => entry.update.sessionUpdate === "subagent_update"
            && entry.update.state != null ? [{parent: entry.sessionId, child: entry.update.sessionId, state: entry.update.state}] : []);
        expect(outcomes).toEqual([
            {parent: coordinatorId, child: childId, state: {state: "idle", stopReason: "cancelled"}},
            {parent: sessionId, child: coordinatorId, state: {state: "idle", stopReason: "end_turn"}},
        ]);
    });

    it("does not publish a late summary after close", async () => {
        await connect();
        history([recordedTurn("completed")], true);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reading = false;
        h.setCodexResponse("thread/turns/list", async () => {
            reading = true;
            await held;
            return {data: [recordedTurn("completed")], nextCursor: null, backwardsCursor: null};
        });
        const replay = load();
        void replay.catch(() => {});
        try {
            await vi.waitFor(() => expect(reading).toBe(true));
            await h.request("session/close", {sessionId});
            release();
            await expect(replay).rejects.toMatchObject({code: -32600});
            expect(states().some(state => state.state === "idle")).toBe(false);
        } finally { release(); }
    });

    it("uses the existing readable failure fallback when the recorded failure has no details", async () => {
        await connect();
        history([{...recordedTurn("failed"), error: null}]);
        await load();
        expect(states()).toEqual([{state: "idle", stopReason: "error", error: {code: -32603, message: "Subagent work failed"}}]);
    });
});
