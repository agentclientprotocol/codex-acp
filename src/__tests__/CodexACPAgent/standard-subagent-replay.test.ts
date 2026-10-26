import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem, TurnStatus} from "../../app-server/v2";
import {
    agentMessageDelta, commandExecutionItem, connectSession, codexResponse, createThread, createTurn, cwd,
    itemStarted, sessionId, turnCompleted, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;
const message = (id: string, text: string): ThreadItem => ({
    type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null,
});
function activity(id = worker, path = "/root/worker"): Extract<ThreadItem, {type: "subAgentActivity"}> {
    return {type: "subAgentActivity", id: `activity-${id}`, agentThreadId: id, agentPath: path,
        kind: "started", model: null, reasoningEffort: null};
}
function spawn(sender = sessionId, receiver = worker): Extract<ThreadItem, {type: "collabAgentToolCall"}> {
    return {type: "collabAgentToolCall", id: `spawn-${receiver}`, tool: "spawnAgent", status: "completed",
        senderThreadId: sender, receiverThreadIds: [receiver], prompt: null, model: null, reasoningEffort: null, agentsStates: {}};
}
const onWorker = (event: ServerNotification): ServerNotification => ({...event, params: {...event.params, threadId: worker}} as ServerNotification);
const command = (status: "inProgress" | "completed") =>
    ({...commandExecutionItem("command", status), aggregatedOutput: status === "completed" ? "Recorded output" : "Before", exitCode: status === "completed" ? 0 : null});
type Stored = {items: ThreadItem[]; parent?: string | null; status?: TurnStatus; paginated?: boolean; unavailable?: boolean; metadataId?: string};

async function flush(h: PromptSession) {
    await h.waitForNotifications();
    await h.request("session/list", {});
}

function history(h: PromptSession, nodes: Record<string, Stored>, onRead?: (id: string, includeTurns: boolean) => void | Promise<void>) {
    const reads: Array<{id: string; includeTurns: boolean}> = [];
    const resumes: string[] = [];
    const thread = (id: string) => ({
        ...createThread(), id: nodes[id]?.metadataId ?? id, parentThreadId: nodes[id]?.parent ?? null,
        status: id === sessionId ? {type: "idle" as const} : {type: "notLoaded" as const},
        historyMode: nodes[id]?.paginated ? "paginated" as const : "legacy" as const,
    });
    h.setCodexResponse("thread/resume", async params => {
        const id = (params as {threadId: string}).threadId;
        resumes.push(id);
        return {...codexResponse("thread/start") as object, thread: thread(id)};
    });
    h.setCodexResponse("thread/read", async params => {
        const {threadId: id, includeTurns = false} = params as {threadId: string; includeTurns?: boolean};
        reads.push({id, includeTurns});
        await onRead?.(id, includeTurns);
        if (includeTurns && nodes[id]?.unavailable) throw new Error("Private missing transcript diagnostic");
        return {thread: {...thread(id), turns: includeTurns && !nodes[id]?.paginated ? [{
            ...createTurn(nodes[id]?.status ?? "completed", "child-turn"), itemsView: "full", items: nodes[id]?.items ?? [],
        }] : []}};
    });
    return {reads, resumes};
}

describe.each([1, 2] as const)("ACP v%s recorded child replay", version => {
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
    const childUpdates = (id = childId) => h.scopedUpdates.filter(entry => entry.sessionId === id);
    const gap = () => h.scopedUpdates.filter(entry => entry.sessionId === sessionId
        && entry.update.sessionUpdate === "agent_thought_chunk" && entry.update.messageId === `${sessionId}:subagent-history-gap`);
    const text = (value: string) => h.scopedUpdates.some(entry => entry.update.sessionUpdate === "agent_message_chunk"
        && entry.update.content !== null && typeof entry.update.content === "object"
        && "text" in entry.update.content && entry.update.content.text === value);

    it.each(["activity", "collab"] as const)("replays retained child content before the response without runtime authority (%s)", async format => {
        await connect();
        const {reads, resumes} = history(h, {
            [sessionId]: {items: [format === "activity" ? activity() : spawn(), message("parent", "Parent history")]},
            [worker]: {parent: "foreign-root", items: [message("saved", "Saved child answer")]},
        });
        const start = h.wireMessages.length;
        await load();
        const boundary = h.scopedUpdates.length;
        await flush(h);
        expect(text("Saved child answer")).toBe(true);
        expect(text("Parent history")).toBe(true);
        expect(resumes).toEqual([sessionId]);
        expect(reads.filter(read => read.id === worker && read.includeTurns)).toHaveLength(1);
        expect(h.scopedUpdates.slice(boundary).filter(entry => entry.sessionId === childId)).toEqual([]);
        expect(h.transcript.some(entry => "permissionRequest" in entry || "elicitationRequest" in entry)).toBe(false);
        const frames = h.wireMessages.slice(start).flatMap(frame => Array.isArray(frame) ? frame : [frame]);
        const response = frames.findIndex(frame => "result" in frame && frame.result !== null
            && typeof frame.result === "object" && "configOptions" in frame.result);
        const replay = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
            && (frame.params as {sessionId: string; update: {messageId?: string}}).sessionId === childId
            && (frame.params as {update: {messageId?: string}}).update.messageId === "saved");
        expect(replay).toBeGreaterThanOrEqual(0);
        expect(response).toBeGreaterThan(replay);
        expect(gap()).toEqual([]);
        await expect(JSON.stringify(childUpdates(), null, 2)).toMatchFileSnapshot(`data/subagent-replay-v${version}-transcript.json`);
    });

    it("visits a conversation once even when both spawn formats and repeated assignments name it", async () => {
        await connect();
        const {reads} = history(h, {
            [sessionId]: {items: [activity(), spawn(), {...activity(), id: "later-assignment", kind: "interacted"}]},
            [worker]: {items: [message("one-answer", "One retained conversation")]},
        });
        await load();
        await flush(h);
        expect(reads.filter(read => read.id === worker && read.includeTurns)).toHaveLength(1);
        expect(childUpdates().filter(entry => entry.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1);
    });

    it("recurses through immediate parents without attributing agent input to the human", async () => {
        await connect();
        history(h, {
            [sessionId]: {items: [activity("coordinator", "/root/coordinator")]},
            coordinator: {parent: sessionId, items: [spawn("coordinator")]},
            [worker]: {parent: "coordinator", items: [userMessageItem(null, "Agent-owned input"), message("nested", "Nested answer")]},
        });
        await load();
        await flush(h);
        const known = new Set([sessionId]);
        for (const entry of h.scopedUpdates) {
            expect(known.has(entry.sessionId)).toBe(true);
            if (entry.update.sessionUpdate === "subagent_update" && typeof entry.update.sessionId === "string") known.add(entry.update.sessionId);
        }
        expect(text("Nested answer")).toBe(true);
        expect(childUpdates().some(entry => entry.update.sessionUpdate === "user_message_chunk")).toBe(false);
        expect(gap()).toHaveLength(1);
    });

    it.each([false, true])("enriches an existing pathless parent before replaying a newly recorded descendant (cold: %s)", async cold => {
        await connect();
        h.emit(itemStarted(spawn(sessionId, "coordinator")));
        await flush(h);
        if (cold) await h.request("session/close", {sessionId});
        history(h, {
            [sessionId]: {items: [activity("coordinator", "/root/coordinator")]},
            coordinator: {items: [activity(worker, "/root/coordinator/worker")]},
            [worker]: {items: [message("new-descendant", "Newly recovered descendant")]},
        });
        await load();
        await flush(h);
        expect(text("Newly recovered descendant")).toBe(true);
        const coordinatorId = `${sessionId}:subagent:coordinator`;
        expect(h.scopedUpdates.some(entry => entry.sessionId === coordinatorId
            && entry.update.sessionUpdate === "subagent_update" && entry.update.sessionId === childId)).toBe(true);
        expect(gap()).toEqual([]);
    });

    it("resolves recoverable multi-level ancestry recorded in reverse order", async () => {
        await connect();
        history(h, {
            [sessionId]: {items: [activity(worker, "/root/a/b/worker"), activity("b", "/root/a/b"), activity("a", "/root/a")]},
            a: {items: []}, b: {items: []}, [worker]: {items: [message("deep", "Deep answer")]},
        });
        await load();
        await flush(h);
        expect(text("Deep answer")).toBe(true);
        expect(gap()).toEqual([]);
    });

    it("does not replace an already observed parent path with an older spawn record", async () => {
        await connect();
        h.emit(itemStarted(activity("coordinator", "/root/current")));
        await flush(h);
        history(h, {
            [sessionId]: {items: [activity("coordinator", "/root/older")]},
            coordinator: {items: [activity(worker, "/root/current/worker")]},
            [worker]: {items: [message("retained-path", "Retained parent path")]},
        });
        await load();
        await flush(h);
        expect(text("Retained parent path")).toBe(true);
        expect(gap()).toEqual([]);
    });

    it("retains ordered paginated items without legacy turns when the outcome is unavailable", async () => {
        await connect();
        const {reads} = history(h, {[sessionId]: {items: [spawn()]}, [worker]: {items: [], paginated: true}});
        const entries = [message("first-page", "First page"), message("last-page", "Last page")].map(item =>
            ({item, turnId: "stored-turn", startedAtMs: 0, completedAtMs: 1}));
        h.setCodexResponse("thread/items/list", async params => {
            const {sortDirection, cursor} = params as {sortDirection: string; cursor: string | null};
            if (sortDirection === "desc") return {data: [entries[1]], nextCursor: null, backwardsCursor: null};
            return {data: cursor ? [entries[1]] : [entries[0]], nextCursor: cursor ? null : "second", backwardsCursor: null};
        });
        const outcomeRead = vi.fn(async () => { throw new Error("Outcome metadata unavailable"); });
        h.setCodexResponse("thread/turns/list", outcomeRead);
        await load();
        await flush(h);
        expect(reads.some(read => read.id === worker && read.includeTurns)).toBe(false);
        expect(outcomeRead).toHaveBeenCalledExactlyOnceWith({threadId: worker, limit: 1, sortDirection: "desc", itemsView: "notLoaded"});
        const ids = childUpdates().flatMap(entry => entry.update.sessionUpdate === "agent_message_chunk" ? [entry.update.messageId] : []);
        expect(ids).toEqual(["first-page", "last-page"]);
    });

    it.each([false, true])("retains associations and sibling history when a child snapshot is unavailable or misidentified (%s)", async mismatch => {
        await connect();
        history(h, {
            [sessionId]: {items: [spawn(), activity("sibling", "/root/sibling")]},
            [worker]: {items: [message("wrong", "Do not publish")], unavailable: !mismatch, ...(mismatch ? {metadataId: "other-thread"} : {})},
            sibling: {items: [message("retained", "Sibling answer")]},
        });
        await load();
        await flush(h);
        expect(text("Do not publish")).toBe(false);
        expect(text("Sibling answer")).toBe(true);
        expect(h.scopedUpdates.some(entry => entry.update.sessionUpdate === "subagent_update" && entry.update.sessionId === childId)).toBe(true);
        expect(gap()).toHaveLength(1);
        expect(h.scopedUpdates.some(entry => JSON.stringify(entry).includes("Private missing transcript diagnostic"))).toBe(false);
    });

    async function startCommand() {
        await connect();
        h.emit(itemStarted(activity()));
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(onWorker(itemStarted(command("inProgress"), "child-turn")));
        await flush(h);
    }

    it("reconciles completed tools before suppressing overlapping live completion and cleanup", async () => {
        await startCommand();
        const before = h.scopedUpdates.length;
        history(h, {
            [sessionId]: {items: [activity()]},
            [worker]: {items: [command("completed"), message("saved", "Saved answer")]},
        }, (id, full) => {
            if (id === worker && full) {
                h.emit({method: "item/completed", params: {threadId: worker, turnId: "child-turn", item: command("completed"), completedAtMs: 0}});
                h.emit(onWorker(agentMessageDelta("Saved answer", "child-turn", "saved")));
                h.emit(onWorker(agentMessageDelta("New answer", "child-turn", "new")));
                h.emit(onWorker(turnCompleted("child-turn")));
            }
        });
        await load();
        await vi.waitFor(() => expect(text("New answer")).toBe(true));
        await flush(h);
        const updates = h.scopedUpdates.slice(before).filter(entry => entry.sessionId === childId);
        expect(updates.some(entry => "status" in entry.update && entry.update.status === "failed")).toBe(false);
        expect(updates.filter(entry => entry.update.sessionUpdate === "agent_message_chunk" && entry.update.messageId === "saved")).toHaveLength(1);
        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot(`data/subagent-replay-v${version}-completed-tool.json`);
    });

    it("restores running command classification without resetting streamed bytes on a duplicate start", async () => {
        await startCommand();
        h.emit({method: "item/commandExecution/outputDelta", params: {threadId: worker, turnId: "child-turn", itemId: "command", delta: "Before"}});
        await flush(h);
        history(h, {[sessionId]: {items: [activity()]}, [worker]: {items: [command("inProgress")], status: "inProgress"}}, (id, full) => {
            if (id === worker && full) {
                h.emit(onWorker(itemStarted(command("inProgress"), "child-turn")));
                h.emit({method: "item/commandExecution/outputDelta", params: {threadId: worker, turnId: "child-turn", itemId: "command", delta: "After"}});
            }
        });
        const before = h.scopedUpdates.length;
        await load();
        await vi.waitFor(() => expect(h.scopedUpdates.slice(before).some(entry =>
            entry.update.sessionUpdate === "subagent_update" && entry.update.sessionId === childId
            && entry.update.state && typeof entry.update.state === "object"
            && (entry.update.state as {state: string}).state === "running")).toBe(true));
        h.emit({method: "item/completed", params: {threadId: worker, turnId: "child-turn", completedAtMs: 0,
            item: {...command("completed"), aggregatedOutput: "BeforeAfter"}}});
        await flush(h);
        const updates = h.scopedUpdates.slice(before).filter(entry => entry.sessionId === childId);
        expect(JSON.stringify(updates)).not.toContain("BeforeAfter");
        expect(gap()).toHaveLength(1);
        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot(`data/subagent-replay-v${version}-running-tool.json`);
    });

    it("does not duplicate incomplete text snapshots over buffered live deltas", async () => {
        await connect();
        h.emit(itemStarted(activity()));
        h.emit(onWorker(turnStarted("child-turn")));
        await flush(h);
        history(h, {
            [sessionId]: {items: [activity()]}, [worker]: {status: "inProgress", items: [message("partial", "Prefix")]},
        }, (id, full) => {
            if (id === worker && full) {
                h.emit(onWorker(agentMessageDelta("Prefix", "child-turn", "partial")));
                h.emit(onWorker(agentMessageDelta(" suffix", "child-turn", "partial")));
            }
        });
        await load();
        await flush(h);
        await vi.waitFor(() => {
            const chunks = childUpdates().flatMap(entry => entry.update.sessionUpdate === "agent_message_chunk"
                && entry.update.content !== null && typeof entry.update.content === "object"
                && "text" in entry.update.content ? [entry.update.content.text] : []);
            expect(chunks.join("")).toBe("Prefix suffix");
        });
        expect(gap()).toHaveLength(1);
    });

    it("does not resurrect a completed live tool from an older running snapshot", async () => {
        await startCommand();
        h.emit({method: "item/completed", params: {threadId: worker, turnId: "child-turn", item: command("completed"), completedAtMs: 0}});
        h.emit(onWorker(turnCompleted("child-turn")));
        await flush(h);
        history(h, {[sessionId]: {items: [activity()]}, [worker]: {items: [command("inProgress")], status: "inProgress"}});
        const before = h.scopedUpdates.length;
        await load();
        await flush(h);
        expect(h.scopedUpdates.slice(before).some(entry => entry.sessionId === childId
            && (entry.update.sessionUpdate === "tool_call" || entry.update.sessionUpdate === "tool_call_update"))).toBe(false);
        expect(gap()).toHaveLength(1);
    });

    it.each([false, true])("does not infer completion from an open-ended image status (paginated: %s)", async paginated => {
        await connect();
        const image: ThreadItem = {type: "imageGeneration", id: "unfinished-image",
            status: "provider-specific-running", revisedPrompt: null, failure: null, result: ""};
        history(h, {[sessionId]: {items: [activity()]}, [worker]: {items: [image], status: "inProgress", paginated}});
        if (paginated) h.setCodexResponse("thread/items/list", async () => ({
            data: [{item: image, turnId: "image-turn", startedAtMs: 0, completedAtMs: null}],
            nextCursor: null, backwardsCursor: null,
        }));
        await load();
        await flush(h);
        expect(childUpdates()).toEqual([]);
        expect(gap()).toHaveLength(1);
    });

    it("removes completed runnable items without reviving or withdrawing a live permission", async () => {
        let answer!: () => void;
        await connect({onRequestPermission: request => new Promise(resolve => {
            answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
        })});
        h.emit(itemStarted(activity()));
        h.emit(onWorker(turnStarted("child-turn")));
        h.emit(onWorker(itemStarted(command("inProgress"), "child-turn")));
        await flush(h);
        const pending = h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: worker, turnId: "child-turn", itemId: "waiting", command: "echo next", cwd,
            commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        });
        try {
            await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
            history(h, {[sessionId]: {items: [activity()]}, [worker]: {items: [command("completed")], status: "inProgress"}});
            await load();
            await vi.waitFor(() => expect(h.scopedUpdates.some(entry => entry.update.sessionUpdate === "subagent_update"
                && entry.update.sessionId === childId && entry.update.state && typeof entry.update.state === "object"
                && (entry.update.state as {state: string}).state === "requires_action")).toBe(true));
            answer();
            await expect(pending).resolves.toEqual({decision: "accept"});
        } finally { answer?.(); }
    });

    it("bounds cyclic history without reparenting a known ancestor", async () => {
        await connect();
        const {reads} = history(h, {
            [sessionId]: {items: [spawn()]},
            [worker]: {items: [spawn(worker, sessionId), message("cycle-safe", "Retained despite cycle")]},
        });
        await load();
        await flush(h);
        expect(text("Retained despite cycle")).toBe(true);
        expect(reads.filter(read => read.id === worker && read.includeTurns)).toHaveLength(1);
        expect(gap()).toHaveLength(1);
    });

    it("does not publish selected child history after a parent closes during the read", async () => {
        await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reading = false;
        history(h, {[sessionId]: {items: [activity()]}, [worker]: {items: [message("too-late", "Do not publish")]}},
            async (id, full) => { if (id === worker && full) { reading = true; await held; } });
        const replay = load();
        void replay.catch(() => {});
        try {
            await vi.waitFor(() => expect(reading).toBe(true));
            await h.request("session/close", {sessionId});
            release();
            await expect(replay).rejects.toMatchObject({code: -32600});
            expect(text("Do not publish")).toBe(false);
        } finally { release(); }
    });

    it("does not fetch child transcripts when replay was not requested", async () => {
        await connect();
        const {reads} = history(h, {[sessionId]: {items: [activity()]}, [worker]: {items: [message("saved", "Not selected")]}});
        await h.request("session/resume", {sessionId, cwd, mcpServers: []});
        await flush(h);
        expect(reads.some(read => read.id === worker)).toBe(false);
        expect(text("Not selected")).toBe(false);
    });
});
