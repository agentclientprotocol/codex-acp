import {afterEach, describe, expect, it, vi} from "vitest";
import type {ReasoningEffort, ServerNotification} from "../../app-server";
import type {ThreadSettings} from "../../app-server/v2";
import {
    agentMessageDelta, connectSession, createThread, createTurn, cwd, itemStarted, sessionId, turnStarted, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;
const activity = (model: string | null = null, effort: ReasoningEffort | null = null, path = "/root/worker") =>
    itemStarted({type: "subAgentActivity", id: "activity", kind: "started", agentThreadId: worker,
        agentPath: path, model, reasoningEffort: effort});
const onWorker = (event: ServerNotification): ServerNotification =>
    ({...event, params: {...event.params, threadId: worker}} as ServerNotification);
function settings(model: string, effort: ReasoningEffort | null): ThreadSettings {
    return {disabledPluginIds: [], cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandboxPolicy: {type: "readOnly", networkAccess: false}, activePermissionProfile: null,
        model, modelProvider: "test", effort, summary: null, serviceTier: null, personality: null,
        collaborationMode: {mode: "default", settings: {model, reasoning_effort: effort, developer_instructions: null}}};
}
type Option = {id?: string; configId?: string; category?: string; currentValue: string; options: Array<{value: string}>};
function configurations(h: PromptSession) {
    return h.scopedUpdates.flatMap(entry => entry.sessionId === childId && entry.update.sessionUpdate === "config_option_update"
        ? [entry.update as {sessionUpdate: "config_option_update"; configOptions: Option[]}] : []);
}
async function flush(h: PromptSession) { await h.waitForNotifications(); await h.request("session/list", {}); }

describe.each([1, 2] as const)("ACP v%s child configuration snapshots", version => {
    let h: PromptSession;
    afterEach(async () => {
        if (h) { await flush(h); h.connection.close(); }
        expectConformingV2SessionUpdates();
    });
    async function connect() { h = await connectSession(version, {v1ClientCapabilities: {subagents: {}}}); }
    function readback(model: string | null, effort: ReasoningEffort | null, options: {
        parent?: string | null; unloaded?: boolean; id?: string;
    } = {}) {
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            return {thread: {...createThread(), id: id === worker ? options.id ?? id : id,
                parentThreadId: id === worker ? options.parent === undefined ? sessionId : options.parent : null,
                model: id === worker ? model : null, reasoningEffort: id === worker ? effort : null,
                status: id === worker && options.unloaded ? {type: "notLoaded"} : {type: "idle"}, turns: []}};
        });
    }
    const load = () => h.request(version === 1 ? "session/load" : "session/resume", {
        sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
    });
    const optionIds = () => configurations(h).at(-1)?.configOptions.map(option => option.configId ?? option.id);

    it("publishes complete singleton snapshots from child observations, clears unset effort, and grants no controls", async () => {
        await connect();
        const parent = h.agent.getSessionState(sessionId).currentModelId;
        readback(null, null);
        h.emit(activity("child-alpha", "high"));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("child-beta", "low")}});
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("child-beta", null)}});
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(3));
        expect(optionIds()).toEqual(["model"]);
        for (const update of configurations(h)) for (const option of update.configOptions) {
            expect(option.options.map(choice => choice.value)).toEqual([option.currentValue]);
        }
        const announcement = h.scopedUpdates.findIndex(entry => entry.update.sessionUpdate === "subagent_update");
        const configuration = h.scopedUpdates.findIndex(entry => entry.sessionId === childId && entry.update.sessionUpdate === "config_option_update");
        expect(configuration).toBeGreaterThan(announcement);
        await expect(h.request("session/set_config_option", {sessionId: childId, configId: "model", value: "child-beta",
            ...(version === 2 ? {type: "id"} : {})})).rejects.toMatchObject({code: -32600});
        expect(h.agent.getSessionState(sessionId).currentModelId).toBe(parent);
        await expect(JSON.stringify(configurations(h), null, 2)).toMatchFileSnapshot(`data/child-configuration-v${version}.json`);
    });

    it("does not inherit unknown configuration from the parent and can report effort without a model", async () => {
        await connect();
        readback(null, null);
        h.emit(activity());
        await flush(h);
        expect(configurations(h)).toEqual([]);
        h.emit(activity(null, "high"));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        expect(optionIds()).toEqual(["reasoning_effort"]);
        expect(configurations(h)[0]!.configOptions[0]!.currentValue).toBe("high");
    });

    it.each([null, "same-model"])("removes unavailable effort from the complete snapshot (model: %s)", async model => {
        await connect();
        readback(null, null);
        h.emit(activity(model, "high"));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        h.emit(activity(model, null));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        expect(optionIds()).toEqual(model ? ["model"] : []);
    });

    it("does not carry reasoning effort to a different model when its effort is unknown", async () => {
        await connect();
        readback(null, null);
        h.emit(activity("first-model", "high"));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        h.emit(activity("next-model", null));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        expect(optionIds()).toEqual(["model"]);
        expect(configurations(h).at(-1)!.configOptions[0]!.currentValue).toBe("next-model");
    });

    it("keeps authoritative settings ahead of lower-ranked metadata and older buffered settings", async () => {
        await connect();
        readback(null, null);
        h.emit(activity("activity-model", "high", "/root/coordinator/worker"));
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("older", "medium")}});
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("latest", "low")}});
        await flush(h);
        expect(configurations(h)).toEqual([]);
        h.emit(itemStarted({type: "subAgentActivity", id: "coordinator", kind: "started", agentThreadId: "coordinator",
            agentPath: "/root/coordinator", model: null, reasoningEffort: null}));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        h.emit({method: "thread/started", params: {thread: {...createThread(), id: worker, parentThreadId: "coordinator",
            model: "stale-thread-model", reasoningEffort: "xhigh"}}});
        h.emit(activity("stale-activity-model", null, "/root/coordinator/worker"));
        await flush(h);
        expect(configurations(h)).toHaveLength(1);
        expect(configurations(h)[0]!.configOptions.map(option => option.currentValue)).toEqual(["latest", "low"]);
    });

    it.each([false, true])("refreshes configuration after the complete replay response (values change: %s)", async change => {
        await connect();
        readback("before", "high");
        h.emit(activity());
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        readback(change ? "after" : "before", change ? "low" : "high");
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let ready = false;
        const delay = async <T>(operation: Promise<T>): Promise<T> => {
            const result = await operation;
            ready = true;
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
        const start = h.wireMessages.length;
        const pending = load();
        void pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(ready).toBe(true));
            await flush(h);
            expect(configurations(h)).toHaveLength(1);
        } finally { release(); }
        await pending;
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        expect(configurations(h).at(-1)!.configOptions.map(option => option.currentValue))
            .toEqual(change ? ["after", "low"] : ["before", "high"]);
        const frames = h.wireMessages.slice(start).flatMap(frame => Array.isArray(frame) ? frame : [frame]);
        const response = frames.findIndex(frame => "result" in frame && frame.result !== null
            && typeof frame.result === "object" && "configOptions" in frame.result);
        const configuration = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
            && (frame.params as {sessionId: string; update: {sessionUpdate: string}}).sessionId === childId
            && (frame.params as {update: {sessionUpdate: string}}).update.sessionUpdate === "config_option_update");
        expect(response).toBeGreaterThanOrEqual(0);
        expect(configuration).toBeGreaterThan(response);
    });

    it("lets child output proceed while readback is pending and rejects a result superseded by native settings", async () => {
        await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let returned = false;
        h.setCodexResponse("thread/read", async () => {
            await held;
            returned = true;
            return {thread: {...createThread(), id: worker, parentThreadId: sessionId, model: "late-old-model", reasoningEffort: "high"}};
        });
        try {
            h.emit(activity());
            h.emit(onWorker(turnStarted("child-turn")));
            h.emit(onWorker(agentMessageDelta("Not blocked", "child-turn", "flowing")));
            await vi.waitFor(() => expect(h.scopedUpdates.some(entry => entry.sessionId === childId
                && entry.update.sessionUpdate === "agent_message_chunk" && entry.update.messageId === "flowing")).toBe(true));
            h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("newer", "low")}});
            await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        } finally { release(); }
        await vi.waitFor(() => expect(returned).toBe(true));
        await flush(h);
        expect(configurations(h)).toHaveLength(1);
        expect(configurations(h)[0]!.configOptions.map(option => option.currentValue)).toEqual(["newer", "low"]);
    });

    it.each(["unload", "close"] as const)("drops a pending read after %s", async ending => {
        await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reading = false;
        let returned = false;
        h.setCodexResponse("thread/read", async () => {
            reading = true;
            await held;
            returned = true;
            return {thread: {...createThread(), id: worker, parentThreadId: sessionId, model: "late", reasoningEffort: "high"}};
        });
        try {
            h.emit(activity());
            await vi.waitFor(() => expect(reading).toBe(true));
            if (ending === "close") await h.request("session/close", {sessionId});
            else h.emit({method: "thread/status/changed", params: {threadId: worker, status: {type: "notLoaded"}}});
            await flush(h);
        } finally { release(); }
        await vi.waitFor(() => expect(returned).toBe(true));
        await flush(h);
        expect(configurations(h)).toEqual([]);
    });

    it("does not apply an earlier attachment's readback after a later resume confirms new values", async () => {
        await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let childReads = 0;
        let returned = false;
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            if (id !== worker) return {thread: {...createThread(), id, turns: []}};
            if (++childReads === 1) {
                await held;
                returned = true;
                return {thread: {...createThread(), id, parentThreadId: sessionId, model: "old-attachment", reasoningEffort: "high"}};
            }
            return {thread: {...createThread(), id, parentThreadId: sessionId, model: "new-attachment", reasoningEffort: "low"}};
        });
        try {
            h.emit(activity());
            await vi.waitFor(() => expect(childReads).toBe(1));
            await h.request("session/resume", {sessionId, cwd, mcpServers: []});
            await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        } finally { release(); }
        await vi.waitFor(() => expect(returned).toBe(true));
        await flush(h);
        expect(configurations(h)).toHaveLength(1);
        expect(configurations(h)[0]!.configOptions.map(option => option.currentValue)).toEqual(["new-attachment", "low"]);
    });

    it.skipIf(version !== 2)("waits for every response in a replay batch before refreshing current options", async () => {
        await connect();
        readback("before", "high");
        h.emit(activity());
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        readback("after", "low");
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(h.agent, "listSessions").mockImplementationOnce(async () => { await held; return {sessions: []}; });
        const resume = vi.spyOn(h.agent, "resumeSessionV2");
        const start = h.wireMessages.length;
        const pending = h.requestBatch([
            {method: "session/resume", params: {sessionId, cwd, replayFrom: {type: "start"}}},
            {method: "session/list", params: {}},
        ]);
        void pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(resume.mock.results).toHaveLength(1));
            await resume.mock.results[0]!.value;
            await flush(h);
            expect(configurations(h)).toHaveLength(1);
            expect(h.wireMessages.slice(start).some(Array.isArray)).toBe(false);
        } finally { release(); }
        await pending;
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        const frames = h.wireMessages.slice(start);
        const batch = frames.findIndex(Array.isArray);
        const configuration = frames.findIndex(frame => !Array.isArray(frame) && "method" in frame
            && frame.method === "session/update" && (frame.params as {sessionId: string}).sessionId === childId
            && (frame.params as {update: {sessionUpdate: string}}).update.sessionUpdate === "config_option_update");
        expect(batch).toBeGreaterThanOrEqual(0);
        expect(configuration).toBeGreaterThan(batch);
    });

    it.each(["unloaded", "foreign-parent", "wrong-id"] as const)("does not confirm readback for %s", async reason => {
        await connect();
        readback("untrusted", "high", {unloaded: reason === "unloaded",
            parent: reason === "foreign-parent" ? "other-root" : sessionId, id: reason === "wrong-id" ? "wrong" : worker});
        h.emit(activity());
        await flush(h);
        expect(configurations(h)).toEqual([]);
    });

    it("keeps replayed configuration historical and ignores foreign runtime starts", async () => {
        await connect();
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            return {thread: {...createThread(), id, parentThreadId: id === worker ? "other-root" : null,
                status: {type: "notLoaded"}, turns: id === sessionId ? [{
                    ...createTurn("completed"), itemsView: "full",
                    items: [{type: "subAgentActivity", id: "recorded", kind: "started",
                        agentThreadId: worker, agentPath: "/root/worker", model: "historical-model", reasoningEffort: "high"}],
                }] : []}};
        });
        const start = h.wireMessages.length;
        await load();
        await flush(h);
        expect(configurations(h)).toHaveLength(1);
        const boundary = configurations(h).length;
        h.emit({method: "thread/started", params: {thread: {...createThread(), id: worker, parentThreadId: "other-root",
            model: "foreign-current-model", reasoningEffort: "low"}}});
        await flush(h);
        expect(configurations(h)).toHaveLength(boundary);
        expect(configurations(h)[0]!.configOptions.map(option => option.currentValue)).toEqual(["historical-model", "high"]);
        const frames = h.wireMessages.slice(start).flatMap(frame => Array.isArray(frame) ? frame : [frame]);
        const response = frames.findIndex(frame => "result" in frame && frame.result !== null
            && typeof frame.result === "object" && "configOptions" in frame.result);
        const configuration = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
            && (frame.params as {sessionId: string; update: {sessionUpdate: string}}).sessionId === childId
            && (frame.params as {update: {sessionUpdate: string}}).update.sessionUpdate === "config_option_update");
        expect(configuration).toBeGreaterThanOrEqual(0);
        expect(response).toBeGreaterThan(configuration);
    });
});
