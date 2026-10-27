import {afterEach, describe, expect, it, vi} from "vitest";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {SubagentUpdate} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {ServerNotification} from "../../app-server";
import {
    connectSession, createThread, createTurn, cwd, itemStarted, sessionId, turnCompleted, turnStarted, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const id = (thread: string) => `${sessionId}:subagent:${thread}`;
const on = (thread: string, event: ServerNotification): ServerNotification =>
    ({...event, params: {...event.params, threadId: thread}} as ServerNotification);
async function flush(h: PromptSession) { await h.waitForNotifications(); await h.request("session/list", {}); }

describe.each([1, 2] as const)("ACP v%s direct child cancellation", version => {
    let h: PromptSession;
    afterEach(async () => {
        if (h) { await flush(h); h.connection.close(); }
        expectConformingV2SessionUpdates();
    });
    const connect = async (options: Parameters<typeof connectSession>[1] = {}) => {
        h = await connectSession(version, {v1ClientCapabilities: {subagents: {}}, ...options});
    };
    const roster = (thread = "worker") => h.scopedUpdates.flatMap(entry =>
        entry.update.sessionUpdate === "subagent_update" && entry.update.sessionId === id(thread) ? [entry.update as SubagentUpdate] : []);
    const capabilities = (thread = "worker") => roster(thread).filter(update => update.capabilities !== undefined).at(-1)?.capabilities;
    const cancellable = (thread = "worker") => capabilities(thread)?.cancel != null;
    const grants = () => roster().filter(update => update.capabilities?.cancel != null).length;
    function spawn(thread = "worker", path = `/root/${thread}`) {
        h.emit(itemStarted({type: "subAgentActivity", id: `spawn-${thread}`, kind: "started", agentThreadId: thread,
            agentPath: path, model: null, reasoningEffort: null}));
    }
    async function start(thread = "worker", turn = `${thread}-turn`, path = `/root/${thread}`) {
        spawn(thread, path);
        h.emit(on(thread, turnStarted(turn)));
        await vi.waitFor(() => expect(cancellable(thread)).toBe(true));
    }
    const load = () => h.request(version === 1 ? "session/load" : "session/resume", {
        sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
    });
    function emptyHistory() {
        h.setCodexResponse("thread/read", async params => ({
            thread: {...createThread(), id: (params as {threadId: string}).threadId, turns: []},
        }));
    }

    it("targets one child, waits for actual completion, and preserves identity for later work", async () => {
        await connect();
        await start();
        await start("sibling");
        await expect(h.request("session/close", {sessionId: id("worker")})).rejects.toMatchObject({code: -32600});
        await expect(h.request("session/prompt", {sessionId: id("worker"), prompt: [{type: "text", text: "No"}]}))
            .rejects.toMatchObject({code: -32600});
        await h.cancel(id("worker"));
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toEqual([{threadId: "worker", turnId: "worker-turn"}]));
        expect(roster().some(update => update.state != null && (update.state as {state: string}).state === "idle")).toBe(false);
        h.emit({method: "turn/completed", params: {threadId: "worker", turn: createTurn("interrupted", "worker-turn")}});
        await vi.waitFor(() => expect(capabilities()?.cancel).toBeNull());
        expect(roster().some(update => update.state != null
            && (update.state as {stopReason?: string}).stopReason === "cancelled")).toBe(true);
        expect(cancellable("sibling")).toBe(true);
        h.emit(on("worker", turnStarted("next-turn")));
        await vi.waitFor(() => expect(cancellable()).toBe(true));
        await expect(JSON.stringify({interrupts: h.turnInterruptCalls(),
            capabilities: roster().filter(update => update.capabilities != null).map(update => update.capabilities)}, null, 2))
            .toMatchFileSnapshot(`data/child-cancellation-v${version}.json`);
    });

    it("cascades through the selected subtree, never to its ancestor or sibling", async () => {
        await connect();
        await start("coordinator");
        await start("worker", "worker-turn", "/root/coordinator/worker");
        await start("sibling");
        await h.cancel(id("coordinator"));
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toHaveLength(2));
        expect(h.turnInterruptCalls()).toEqual([
            {threadId: "coordinator", turnId: "coordinator-turn"}, {threadId: "worker", turnId: "worker-turn"},
        ]);
        expect(cancellable("sibling")).toBe(true);
    });

    it("withdraws only selected requests and rejects an accepted late reply", async () => {
        const answers = new Map<string, () => void>();
        await connect({onRequestPermission: request => new Promise(resolve => {
            answers.set(request.sessionId, () => resolve({outcome: {outcome: "selected", optionId: request.options[0]!.optionId}}));
        })});
        await start();
        await start("sibling");
        const approval = (thread: string) => h.triggerApproval("item/commandExecution/requestApproval", {
            threadId: thread, turnId: `${thread}-turn`, itemId: `${thread}-approval`, command: "echo ok", cwd,
            commandActions: [], reason: null, availableDecisions: ["accept", "decline"],
        });
        const worker = approval("worker");
        const sibling = approval("sibling");
        try {
            await vi.waitFor(() => expect(answers.size).toBe(2));
            await h.cancel(id("worker"));
            await expect(worker).resolves.toEqual({decision: "cancel"});
            answers.get(id("worker"))!();
            answers.get(id("sibling"))!();
            await expect(sibling).resolves.toEqual({decision: "accept"});
            expect(h.turnInterruptCalls()).toEqual([{threadId: "worker", turnId: "worker-turn"}]);
        } finally { for (const answer of answers.values()) answer(); }
    });

    it("deduplicates an in-flight interrupt without inventing a cancelled outcome", async () => {
        await connect();
        await start();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        h.setCodexResponse("turn/interrupt", async () => { await held; return {}; });
        try {
            await h.cancel(id("worker"));
            await vi.waitFor(() => expect(h.turnInterruptCalls()).toHaveLength(1));
            await h.cancel(id("worker"));
            await flush(h);
            expect(h.turnInterruptCalls()).toHaveLength(1);
            expect(roster().some(update => update.state != null
                && (update.state as {stopReason?: string}).stopReason === "cancelled")).toBe(false);
        } finally { release(); }
    });

    it("ignores raw and foreign IDs and stale cancellations after real work completion", async () => {
        await connect();
        await start();
        await h.cancel("worker");
        await h.cancel(`${sessionId}:subagent:foreign`);
        h.emit(on("worker", turnCompleted("worker-turn")));
        await h.cancel(id("worker"));
        await flush(h);
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it("revokes on unload and ignores cancellation even when publication is backpressured", async () => {
        await connect();
        await start();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        h.agent["codexAcpClient"]["enqueueSessionNotification"](sessionId, () => held);
        try {
            h.emit({method: "thread/status/changed", params: {threadId: "worker", status: {type: "notLoaded"}}});
            await h.cancel(id("worker"));
            expect(h.turnInterruptCalls()).toEqual([]);
        } finally { release(); }
        await vi.waitFor(() => expect(capabilities()?.cancel).toBeNull());
    });

    it("targets the newest provider turn even if older output is backpressured", async () => {
        await connect();
        await start();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        h.agent["codexAcpClient"]["enqueueSessionNotification"](sessionId, () => held);
        try {
            h.emit(on("worker", turnCompleted("worker-turn")));
            h.emit(on("worker", turnStarted("newest")));
            h.appServer["runningTurnIds"].set("worker", "newest");
            await h.cancel(id("worker"));
            await vi.waitFor(() => expect(h.turnInterruptCalls()).toEqual([{threadId: "worker", turnId: "newest"}]));
        } finally { release(); }
    });

    it("allows retry after an interrupt failure without fabricating cancellation", async () => {
        await connect();
        await start();
        let attempted = false;
        h.setCodexResponse("turn/interrupt", async () => { attempted = true; throw new Error("Provider stop failed"); });
        await h.cancel(id("worker"));
        await vi.waitFor(() => expect(attempted).toBe(true));
        await flush(h);
        h.setCodexResponse("turn/interrupt", async () => ({}));
        await h.cancel(id("worker"));
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toHaveLength(2));
        expect(roster().some(update => update.state != null
            && (update.state as {stopReason?: string}).stopReason === "cancelled")).toBe(false);
    });

    it("does not grant control over a loaded foreign child from copied history", async () => {
        await connect();
        h.appServer["runningTurnIds"].set("worker", "foreign-turn");
        h.setCodexResponse("thread/read", async params => {
            const {threadId, includeTurns} = params as {threadId: string; includeTurns?: boolean};
            return {thread: {...createThread(), id: threadId, parentThreadId: threadId === "worker" ? "other-root" : null,
                status: {type: "active", activeFlags: []}, turns: threadId === sessionId && includeTurns ? [{
                    ...createTurn("completed"), itemsView: "full", items: [{
                        type: "subAgentActivity", id: "stored-spawn", kind: "started", agentThreadId: "worker",
                        agentPath: "/root/worker", model: null, reasoningEffort: null,
                    }],
                }] : []}};
        });
        await load();
        await flush(h);
        await h.cancel(id("worker"));
        await flush(h);
        expect(grants()).toBe(0);
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it("does not restore cancellation from history before the successful response", async () => {
        await connect();
        await start();
        emptyHistory();
        const beforeGrants = grants();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let ready = false;
        const hold = async <T>(operation: Promise<T>) => { const result = await operation; ready = true; await held; return result; };
        if (version === 1) {
            const operation = h.agent.loadSession.bind(h.agent);
            vi.spyOn(h.agent, "loadSession").mockImplementation(params => hold(operation(params)));
        } else {
            const operation = h.agent.resumeSessionV2.bind(h.agent);
            vi.spyOn(h.agent, "resumeSessionV2").mockImplementation(params => hold(operation(params)));
        }
        const startIndex = h.wireMessages.length;
        const pending = load();
        void pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(ready).toBe(true));
            await h.cancel(id("worker"));
            await flush(h);
            expect(h.turnInterruptCalls()).toEqual([]);
            expect(grants()).toBe(beforeGrants);
        } finally { release(); }
        await pending;
        await vi.waitFor(() => expect(grants()).toBe(beforeGrants + 1));
        const frames = h.wireMessages.slice(startIndex).flatMap(frame => Array.isArray(frame) ? frame : [frame]);
        const response = frames.findIndex(frame => "result" in frame && frame.result != null
            && typeof frame.result === "object" && "configOptions" in frame.result);
        const grant = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
            && (frame.params as {update: {capabilities?: {cancel?: object}}}).update.capabilities?.cancel != null);
        expect(grant).toBeGreaterThan(response);
        await h.cancel(id("worker"));
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toHaveLength(1));
    });

    it("does not grant cancellation after a failed replay response", async () => {
        await connect();
        await start();
        emptyHistory();
        const beforeGrants = grants();
        if (version === 1) {
            const operation = h.agent.loadSession.bind(h.agent);
            vi.spyOn(h.agent, "loadSession").mockImplementation(async params => { await operation(params); throw RequestError.internalError("Failed"); });
        } else {
            const operation = h.agent.resumeSessionV2.bind(h.agent);
            vi.spyOn(h.agent, "resumeSessionV2").mockImplementation(async params => { await operation(params); throw RequestError.internalError("Failed"); });
        }
        await expect(load()).rejects.toMatchObject({code: -32603});
        await flush(h);
        await h.cancel(id("worker"));
        await flush(h);
        expect(grants()).toBe(beforeGrants);
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it("suspends old grants even when setup fails before touching the provider", async () => {
        await connect();
        await start();
        if (version === 1) vi.spyOn(h.agent, "loadSession").mockRejectedValueOnce(RequestError.internalError("Unavailable"));
        else vi.spyOn(h.agent, "resumeSessionV2").mockRejectedValueOnce(RequestError.internalError("Unavailable"));
        await expect(load()).rejects.toMatchObject({code: -32603});
        await h.cancel(id("worker"));
        await flush(h);
        expect(h.turnInterruptCalls()).toEqual([]);
    });

    it.skipIf(version !== 2)("waits for the entire replay response batch before granting cancellation", async () => {
        await connect();
        await start();
        emptyHistory();
        const beforeGrants = grants();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(h.agent, "listSessions").mockImplementationOnce(async () => { await held; return {sessions: []}; });
        const resume = vi.spyOn(h.agent, "resumeSessionV2");
        const pending = h.requestBatch([
            {method: "session/resume", params: {sessionId, cwd, replayFrom: {type: "start"}}},
            {method: "session/list", params: {}},
        ]);
        void pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(resume.mock.results).toHaveLength(1));
            await resume.mock.results[0]!.value;
            await h.cancel(id("worker"));
            await flush(h);
            expect(h.turnInterruptCalls()).toEqual([]);
            expect(grants()).toBe(beforeGrants);
        } finally { release(); }
        await pending;
        await vi.waitFor(() => expect(grants()).toBe(beforeGrants + 1));
        await h.cancel(id("worker"));
        await vi.waitFor(() => expect(h.turnInterruptCalls()).toHaveLength(1));
    });
});
