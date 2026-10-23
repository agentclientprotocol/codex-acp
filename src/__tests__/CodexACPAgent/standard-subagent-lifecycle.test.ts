import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";
import {
    agentMessageDelta, commandExecutionItem, connectSession, codexResponse, createThread, createTurn, cwd,
    itemStarted, sessionId, turnCompleted, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;

function onThread(event: ServerNotification, threadId = worker): ServerNotification {
    return {...event, params: {...event.params, threadId}} as ServerNotification;
}

function activity(): ServerNotification {
    return itemStarted({type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: worker, agentPath: "/root/worker"});
}

function collab(tool: "spawnAgent" | "sendInput"): Extract<ThreadItem, {type: "collabAgentToolCall"}> {
    return {type: "collabAgentToolCall", id: tool, tool, status: "completed", senderThreadId: sessionId,
        receiverThreadIds: [worker], prompt: "Delegate", model: null, reasoningEffort: null, agentsStates: {}};
}

function message(text: string): ThreadItem {
    return {type: "agentMessage", id: "historical-message", text, phase: null, memoryCitation: null, delivery: null, questions: null};
}

function hasText(h: PromptSession, text: string): boolean {
    return h.scopedUpdates.some(entry => entry.sessionId === childId && entry.update.sessionUpdate === "agent_message_chunk"
        && typeof entry.update.content === "object" && entry.update.content !== null
        && "type" in entry.update.content && entry.update.content.type === "text"
        && "text" in entry.update.content && entry.update.content.text === text);
}

async function flush(h: PromptSession): Promise<void> {
    await h.waitForNotifications();
    await h.request("session/list", {});
}

function history(h: PromptSession, rootItems: ThreadItem[], childItems: ThreadItem[] = [], options: {
    parentThreadId?: string | null;
    loaded?: boolean;
    onRead?: (threadId: string, includeTurns: boolean) => void | Promise<void>;
} = {}) {
    const thread = (id: string) => ({
        ...createThread(), id, sessionId,
        parentThreadId: id === worker ? options.parentThreadId === undefined ? sessionId : options.parentThreadId : null,
        status: id === worker && options.loaded === false ? {type: "notLoaded" as const} : {type: "idle" as const},
    });
    const resumes: string[] = [];
    h.setCodexResponse("thread/resume", async params => {
        const id = (params as {threadId: string}).threadId;
        resumes.push(id);
        return {...codexResponse("thread/start") as object, thread: thread(id)};
    });
    h.setCodexResponse("thread/read", async params => {
        const {threadId, includeTurns = false} = params as {threadId: string; includeTurns?: boolean};
        await options.onRead?.(threadId, includeTurns);
        return {thread: {...thread(threadId), turns: [{
            ...createTurn("completed", threadId === worker ? "child-active" : "history"),
            itemsView: "full", items: threadId === worker ? childItems : rootItems,
        }]}};
    });
    return resumes;
}

describe.each([1, 2] as const)("ACP v%s standard child lifecycle boundaries", version => {
    let h: PromptSession;
    afterEach(async () => {
        if (h) {
            await flush(h);
            h.connection.close();
        }
        expectConformingV2SessionUpdates();
    });

    async function connect(options: Parameters<typeof connectSession>[1] = {}) {
        h = await connectSession(version, {v1ClientCapabilities: {subagents: {}}, ...options});
        return h;
    }

    const load = () => h.request(version === 1 ? "session/load" : "session/resume", {
        sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
    });
    const state = () => h.scopedUpdates.flatMap(entry => {
        if (version === 2 && entry.sessionId === childId && entry.update.sessionUpdate === "state_update") return [entry.update.state];
        if (version === 1 && entry.update.sessionUpdate === "subagent_update"
            && entry.update.sessionId === childId && entry.update.state && typeof entry.update.state === "object") {
            return [(entry.update.state as {state: string}).state];
        }
        return [];
    }).at(-1);

    async function startCommand() {
        await connect();
        h.emit(activity());
        h.emit(onThread(turnStarted("child-active")));
        h.emit(onThread(itemStarted(commandExecutionItem("child-command"), "child-active")));
        await flush(h);
    }

    async function dump(name: string, start = 0) {
        await flush(h);
        const updates = h.scopedUpdates.slice(start).filter(entry =>
            entry.sessionId === childId || entry.update.sessionUpdate === "subagent_update");
        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot(`data/standard-lifecycle-v${version}-${name}.json`);
    }

    it.each(["collab", "activity"] as const)("replays %s child history and reattaches its live stream", async format => {
        await connect({onRequestPermission: async request => ({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}})});
        const spawn = format === "collab" ? collab("spawnAgent") : (activity().params as {item: ThreadItem}).item;
        const resumes = history(h, [spawn], [message("Retained answer")]);
        await load();
        expect(hasText(h, "Retained answer")).toBe(true);
        expect(resumes).toEqual([sessionId, worker]);
        await vi.waitFor(() => expect(state()).toBe("idle"));
        h.emit(itemStarted(collab("sendInput")));
        h.emit(onThread(turnStarted("child-active")));
        h.emit(onThread(agentMessageDelta("Live after restore", "child-active", "live-message")));
        await flush(h);
        expect(hasText(h, "Live after restore")).toBe(true);
        expect(await h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: worker, turnId: "child-active", itemId: "restored-command", command: "echo hello", cwd,
            commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        })).toEqual({decision: "accept"});
        expect(h.transcript.some(entry => "permissionRequest" in entry && entry.permissionRequest.sessionId === childId)).toBe(true);
        h.emit(onThread(turnCompleted("child-active")));
        await dump(`restored${format === "activity" ? "-activity" : ""}`);
    });

    it("does not steal a live original child when loading copied fork history", async () => {
        await connect({onRequestPermission: async request => ({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}})});
        h.emit(activity());
        h.emit(onThread(turnStarted("child-active")));
        await flush(h);
        const resumes = history(h, [collab("spawnAgent")], [message("Copied answer")]);
        h.setCodexResponse("thread/fork", async () => ({
            ...codexResponse("thread/start") as object, thread: {...createThread(), id: "fork", sessionId: "fork", forkedFromId: sessionId},
        }));
        await h.request("session/fork", {sessionId, cwd, mcpServers: []});
        await h.request(version === 1 ? "session/load" : "session/resume", {
            sessionId: "fork", cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
        });
        expect(resumes).toEqual(["fork"]);
        h.emit(onThread(agentMessageDelta("Still original", "child-active", "original-only")));
        await flush(h);
        expect(hasText(h, "Still original")).toBe(true);
        expect(h.scopedUpdates.some(entry => entry.sessionId === `fork:subagent:${worker}`
            && entry.update.sessionUpdate === "agent_message_chunk" && "messageId" in entry.update
            && entry.update.messageId === "original-only")).toBe(false);
        await h.agent.cancel({sessionId: "fork"});
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it.each(["another-root", null, "not-loaded"] as const)("does not resume or confirm activity from unverified/inactive history (%s)", async owner => {
        await connect();
        const resumes = history(h, [collab("spawnAgent")], [message("Historical only")], {
            parentThreadId: owner === "not-loaded" ? sessionId : owner, loaded: owner !== "not-loaded",
        });
        await load();
        expect(hasText(h, "Historical only")).toBe(true);
        expect(resumes).toEqual([sessionId]);
        await flush(h);
        expect(state()).toBeUndefined();
        await dump("historical-only");
    });

    it("receives an inactive owned child when a live sendInput wakes it later", async () => {
        await connect();
        const resumes = history(h, [collab("spawnAgent")], [message("Historical only")], {loaded: false});
        await load();
        await flush(h);
        expect(resumes).toEqual([sessionId]);
        expect(state()).toBeUndefined();
        h.emit(itemStarted(collab("sendInput")));
        h.emit(onThread(turnStarted("child-active")));
        h.emit(onThread(agentMessageDelta("Awake", "child-active", "awake-message")));
        await flush(h);
        expect(hasText(h, "Awake")).toBe(true);
        expect(state()).toBe("running");
    });

    it("requires verified runtime ancestry for nested copied children", async () => {
        await connect();
        const coordinator = "coordinator";
        const resumes: string[] = [];
        const items: Record<string, ThreadItem[]> = {
            [sessionId]: [{...collab("spawnAgent"), receiverThreadIds: [coordinator]}],
            [coordinator]: [{...collab("spawnAgent"), senderThreadId: coordinator}],
            [worker]: [message("Nested historical answer")],
        };
        h.setCodexResponse("thread/resume", async params => {
            const id = (params as {threadId: string}).threadId;
            resumes.push(id);
            return {...codexResponse("thread/start") as object, thread: {...createThread(), id, sessionId}};
        });
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            return {thread: {...createThread(), id, sessionId,
                parentThreadId: id === coordinator ? "original-root" : id === worker ? coordinator : null,
                turns: [{...createTurn("completed", "history"), itemsView: "full", items: items[id] ?? []}],
            }};
        });
        await load();
        expect(hasText(h, "Nested historical answer")).toBe(true);
        expect(resumes).toEqual([sessionId]);
        await dump("nested-historical");
    });

    it("announces the tree before terminal cleanup during replay", async () => {
        await startCommand();
        let release!: () => void;
        let reading = false;
        const held = new Promise<void>(resolve => { release = resolve; });
        history(h, [], [], {onRead: async (id, full) => {
            if (id === sessionId && full) { reading = true; await held; }
        }});
        const start = h.scopedUpdates.length;
        const pending = load();
        pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(reading).toBe(true));
            h.emit(onThread(turnCompleted("child-active")));
        } finally {
            release();
        }
        await pending;
        await vi.waitFor(() => expect(state()).toBe("idle"));
        const known = new Set([sessionId]);
        for (const entry of h.scopedUpdates.slice(start)) {
            expect(known.has(entry.sessionId), JSON.stringify(entry)).toBe(true);
            if (entry.update.sessionUpdate === "subagent_update" && typeof entry.update.sessionId === "string") {
                known.add(entry.update.sessionId);
            }
        }
        await dump("cleanup", start);
    });

    it("reconciles replayed tool completion before suppressing its duplicate live event", async () => {
        await startCommand();
        const completed = {...commandExecutionItem("child-command", "completed"), exitCode: 0};
        let emitted = false;
        history(h, [(activity().params as {item: ThreadItem}).item], [completed], {onRead: (id, full) => {
            if (id === worker && full && !emitted) {
                emitted = true;
                h.emit(onThread({method: "item/completed", params: {threadId: worker, turnId: "child-active", item: completed, completedAtMs: 0}}));
                h.emit(onThread(turnCompleted("child-active")));
            }
        }});
        const start = h.scopedUpdates.length;
        await load();
        await vi.waitFor(() => expect(state()).toBe("idle"));
        await flush(h);
        const statuses = h.scopedUpdates.slice(start).flatMap(entry =>
            entry.sessionId === childId && "toolCallId" in entry.update && entry.update.toolCallId === "child-command"
                && "status" in entry.update && entry.update.status ? [entry.update.status] : []);
        expect(statuses.at(-1)).toBe("completed");
        expect(statuses).not.toContain("failed");
        await dump("completed-replay", start);
    });

    it.each([false, true])("retains blocked-work state before the replay response (new native turn: %s)", async newTurn => {
        let answer: (() => void) | undefined;
        await connect({onRequestPermission: request => new Promise(resolve => {
            answer = () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}});
        })});
        h.emit(activity());
        h.emit(onThread(turnStarted("child-active")));
        await flush(h);
        history(h, []);
        let release!: () => void;
        let ready = false;
        const held = new Promise<void>(resolve => { release = resolve; });
        const delay = async <T>(operation: Promise<T>): Promise<T> => {
            const response = await operation;
            ready = true;
            await held;
            return response;
        };
        if (version === 1) {
            const operation = h.agent.loadSession.bind(h.agent);
            vi.spyOn(h.agent, "loadSession").mockImplementation(params => delay(operation(params)));
        } else {
            const operation = h.agent.resumeSessionV2.bind(h.agent);
            vi.spyOn(h.agent, "resumeSessionV2").mockImplementation(params => delay(operation(params)));
        }
        const start = h.scopedUpdates.length;
        const pending = load();
        pending.catch(() => {});
        let permission: Promise<unknown> | undefined;
        try {
            await vi.waitFor(() => expect(ready).toBe(true));
            const turnId = newTurn ? "child-next" : "child-active";
            if (newTurn) {
                h.emit(onThread(turnCompleted("child-active")));
                h.emit(onThread(turnStarted(turnId)));
                h.emit(onThread(itemStarted(commandExecutionItem("during-replay"), turnId)));
            }
            permission = h.triggerApproval("item/commandExecution/requestApproval", {
                threadId: worker, turnId, itemId: "during-replay", command: "echo hello", cwd,
                commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
            });
            await vi.waitFor(() => expect(answer).toBeDefined());
            release();
            await pending;
            await vi.waitFor(() => expect(state()).toBe("requires_action"));
            await dump(`blocked${newTurn ? "-next-turn" : ""}`, start);
        } finally {
            release();
            answer?.();
            await permission;
            await pending;
        }
    });

    it("keeps command streaming and terminal completion across a new parent handler", async () => {
        await startCommand();
        h.emit(onThread({method: "item/commandExecution/outputDelta", params: {
            threadId: worker, turnId: "child-active", itemId: "child-command", delta: "before\n",
        }}));
        await flush(h);
        const prompt = h.sendPrompt([{type: "text", text: "Continue parent"}]);
        await vi.waitFor(() => expect(h.turnStartParams).toHaveLength(1));
        h.emit(turnStarted());
        const id = h.turnStartParams[0]!["clientUserMessageId"];
        h.emit(itemStarted(userMessageItem(typeof id === "string" ? id : null, "Continue parent")));
        h.emit(turnCompleted());
        await prompt;
        await h.promptRunFinished();
        const start = h.scopedUpdates.length;
        h.emit(onThread({method: "item/commandExecution/outputDelta", params: {
            threadId: worker, turnId: "child-active", itemId: "child-command", delta: "after\n",
        }}));
        h.emit(onThread({method: "item/completed", params: {threadId: worker, turnId: "child-active",
            item: {...commandExecutionItem("child-command", "completed"), aggregatedOutput: "before\nafter\n", exitCode: 0}, completedAtMs: 0}}));
        h.emit(onThread(turnCompleted("child-active")));
        await flush(h);
        if (version === 2) {
            const updates = h.scopedUpdates.slice(start).filter(entry => entry.sessionId === childId).map(entry => entry.update);
            expect(updates.some(update => update.sessionUpdate === "terminal_output_chunk")).toBe(true);
            expect(updates.some(update => update.sessionUpdate === "terminal_update" && update.exitStatus
                && typeof update.exitStatus === "object" && "exitCode" in update.exitStatus && update.exitStatus.exitCode === 0)).toBe(true);
        }
        await dump("terminal", start);
    });
});
