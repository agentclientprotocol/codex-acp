import {afterEach, describe, expect, it, vi} from "vitest";
import type {ReasoningEffort} from "../../app-server";
import type {ThreadSettings} from "../../app-server/v2";
import {
    agentMessageDelta, connectSession, createThread, createTurn, cwd, itemStarted, sessionId, turnStarted, type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

const worker = "worker";
const childId = `${sessionId}:subagent:${worker}`;
const spawn = {type: "subAgentActivity" as const, id: "spawn", kind: "started" as const,
    agentThreadId: worker, agentPath: "/root/worker", model: null, reasoningEffort: null};

function settings(model: string, effort: ReasoningEffort | null): ThreadSettings {
    return {
        disabledPluginIds: [], cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandboxPolicy: {type: "readOnly", networkAccess: false}, activePermissionProfile: null, model, effort,
        modelProvider: "test", serviceTier: null, summary: null, personality: null,
        collaborationMode: {mode: "default", settings: {model, reasoning_effort: effort, developer_instructions: null}},
    };
}

type ReportedOption = {id?: string; configId?: string; currentValue: string; options: Array<{value: string}>};

function configurations(h: PromptSession) {
    return h.scopedUpdates.flatMap(entry => entry.sessionId === childId && entry.update.sessionUpdate === "config_option_update"
        ? [entry.update as {sessionUpdate: "config_option_update"; configOptions: ReportedOption[]}] : []);
}

async function flush(h: PromptSession): Promise<void> {
    await h.waitForNotifications();
    await h.request("session/list", {});
}

describe.each([1, 2] as const)("ACP v%s subagent reporting", version => {
    let h: PromptSession;
    afterEach(async () => {
        if (h) {
            await flush(h);
            h.connection.close();
        }
        expectConformingV2SessionUpdates();
    });

    async function connect() {
        h = await connectSession(version, {v1ClientCapabilities: {subagents: {}}});
    }

    const load = () => h.request(version === 1 ? "session/load" : "session/resume", {
        sessionId, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
    });

    function readConfiguration(model: string | null, effort: ReasoningEffort | null) {
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            return {thread: {...createThread(), id, model: id === worker ? model : null,
                reasoningEffort: id === worker ? effort : null}};
        });
    }

    it("reports only child values as singleton options, replaces snapshots, and grants no mutation", async () => {
        await connect();
        const parentModel = h.agent.getSessionState(sessionId).currentModelId;
        readConfiguration("child-special", "high");
        h.emit(itemStarted(spawn));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        const announcement = h.scopedUpdates.findIndex(entry => entry.update.sessionUpdate === "subagent_update");
        const configuration = h.scopedUpdates.findIndex(entry => entry.sessionId === childId
            && entry.update.sessionUpdate === "config_option_update");
        expect(configuration).toBeGreaterThan(announcement);
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("child-next", "low")}});
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("child-final", null)}});
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(3));
        for (const update of configurations(h)) {
            for (const option of update.configOptions) expect(option.options.map(value => value.value)).toEqual([option.currentValue]);
        }
        expect(configurations(h).at(-1)!.configOptions).toHaveLength(1);
        await expect(h.request("session/set_config_option", {
            sessionId: childId, configId: "model", value: "child-final", ...(version === 2 ? {type: "id"} : {}),
        })).rejects.toMatchObject({code: -32600});
        expect(h.agent.getSessionState(sessionId).currentModelId).toBe(parentModel);
        await expect(JSON.stringify(configurations(h), null, 2)).toMatchFileSnapshot(`data/standard-reporting-v${version}-configuration.json`);
    });

    it("does not invent child configuration from the parent when it is unavailable", async () => {
        await connect();
        readConfiguration(null, null);
        h.emit(itemStarted(spawn));
        await flush(h);
        expect(configurations(h)).toEqual([]);
    });

    it("keeps child output flowing while optional configuration lookup is pending", async () => {
        await connect();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        h.setCodexResponse("thread/read", async () => {
            await held;
            return {thread: {...createThread(), id: worker, model: "older", reasoningEffort: "high"}};
        });
        const onWorker = <T extends {params: object}>(event: T) => ({...event, params: {...event.params, threadId: worker}});
        try {
            h.emit(itemStarted(spawn));
            h.emit(onWorker(turnStarted("child-turn")));
            h.emit(onWorker(agentMessageDelta("Not delayed", "child-turn", "flowing")));
            await vi.waitFor(() => expect(h.scopedUpdates.some(entry => entry.sessionId === childId
                && entry.update.sessionUpdate === "agent_message_chunk" && entry.update.messageId === "flowing")).toBe(true));
            h.emit({method: "thread/settings/updated", params: {threadId: worker, threadSettings: settings("newer", "low")}});
            await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
            expect(configurations(h)[0]!.configOptions[0]!.currentValue).toBe("newer");
        } finally {
            release();
        }
        await flush(h);
        expect(configurations(h)).toHaveLength(1);
    });

    it("refreshes current configuration only after the replay response", async () => {
        await connect();
        readConfiguration("before", "high");
        h.emit(itemStarted(spawn));
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(1));
        readConfiguration("after", "low");
        let release!: () => void;
        let ready = false;
        const held = new Promise<void>(resolve => { release = resolve; });
        const delay = async <T>(response: Promise<T>): Promise<T> => {
            const result = await response;
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
        pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(ready).toBe(true));
            await flush(h);
            expect(configurations(h)).toHaveLength(1);
        } finally {
            release();
        }
        await pending;
        await vi.waitFor(() => expect(configurations(h)).toHaveLength(2));
        expect(configurations(h).at(-1)!.configOptions[0]!.currentValue).toBe("after");
        const frames = h.wireMessages.slice(start).flatMap(frame => Array.isArray(frame) ? frame : [frame]);
        const response = frames.findIndex(frame => "result" in frame && frame.result !== null
            && typeof frame.result === "object" && "configOptions" in frame.result);
        const config = frames.findIndex(frame => "method" in frame && frame.method === "session/update"
            && (frame.params as {sessionId: string; update: {sessionUpdate: string}}).sessionId === childId
            && (frame.params as {update: {sessionUpdate: string}}).update.sessionUpdate === "config_option_update");
        expect(response).toBeGreaterThanOrEqual(0);
        expect(config).toBeGreaterThan(response);
    });

    it.each(["completed", "interrupted", "failed", "inProgress", "missing"] as const)(
        "replays the recorded %s outcome without claiming a current runtime", async status => {
            await connect();
            const turn = createTurn(status === "missing" ? "completed" : status, "recorded-turn");
            if (status === "failed") turn.error = {
                message: "Recorded failure", codexErrorInfo: null, additionalDetails: null, misalignment: null,
            };
            h.setCodexResponse("thread/read", async params => {
                const id = (params as {threadId: string}).threadId;
                return {thread: {...createThread(), id, status: {type: "notLoaded"},
                    parentThreadId: id === worker ? sessionId : null,
                    turns: id === worker ? status === "missing" ? [] : [turn]
                        : [{...createTurn("completed"), itemsView: "full", items: [spawn]}],
                }};
            });
            await load();
            const boundary = h.scopedUpdates.length;
            await flush(h);
            expect(h.scopedUpdates.slice(boundary).filter(entry => entry.sessionId === childId
                || entry.update.sessionUpdate === "subagent_update")).toEqual([]);
            expect(h.turnInterruptCalls()).toEqual([]);
            expect(configurations(h)).toEqual([]);
            const outcomes = h.scopedUpdates.flatMap(entry => entry.update.sessionUpdate === "subagent_update"
                && entry.update.sessionId === childId && entry.update.state ? [entry.update.state] : []);
            if (status === "missing" || status === "inProgress") {
                expect(outcomes).toEqual([]);
            } else {
                expect(outcomes).toHaveLength(1);
                await expect(JSON.stringify(outcomes, null, 2)).toMatchFileSnapshot(`data/standard-reporting-v${version}-outcome-${status}.json`);
            }
        },
    );

    it.each([true, false])("replays paginated history independently of outcome metadata (summary available: %s)", async available => {
        await connect();
        h.setCodexResponse("thread/read", async params => {
            const id = (params as {threadId: string}).threadId;
            return {thread: {...createThread(), id, status: {type: "notLoaded"},
                parentThreadId: id === worker ? sessionId : null, historyMode: id === worker ? "paginated" : "legacy",
                turns: id === worker ? [] : [{...createTurn("completed"), itemsView: "full", items: [spawn]}],
            }};
        });
        h.setCodexResponse("thread/turns/list", async () => {
            if (!available) throw new Error("Turn summary unavailable");
            return {data: [createTurn("interrupted", "recorded-turn")], nextCursor: null, backwardsCursor: null};
        });
        h.setCodexResponse("thread/items/list", async () => ({
            data: available ? [] : [{
                turnId: "recorded-turn", startedAtMs: 0, completedAtMs: 1,
                item: {type: "agentMessage", id: "retained", text: "Retained history", phase: null,
                    memoryCitation: null, delivery: null, questions: null},
            }], nextCursor: null, backwardsCursor: null,
        }));
        await load();
        await flush(h);
        const outcomes = h.scopedUpdates.flatMap(entry => entry.update.sessionUpdate === "subagent_update"
            && entry.update.sessionId === childId && entry.update.state ? [entry.update.state] : []);
        expect(outcomes).toEqual(available ? [{state: "idle", stopReason: "cancelled"}] : []);
        if (!available) {
            expect(h.scopedUpdates.some(entry => entry.sessionId === childId
                && entry.update.sessionUpdate === "agent_message_chunk" && entry.update.messageId === "retained")).toBe(true);
        }
    });
});
