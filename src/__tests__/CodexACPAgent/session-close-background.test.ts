import {describe, expect, it, vi} from "vitest";
import {connectSession, createThread, itemStarted, sessionId} from "./v2-prompt-harness";

describe.each([1, 2] as const)("ACP v%s background teardown", version => {
    it.each(["session/close", "session/delete"])("stops all pages of background processes before %s responds without AIR", async method => {
        const h = await connectSession(version);
        const events: unknown[] = [];
        let release!: () => void;
        const stopping = new Promise<void>(resolve => { release = resolve; });
        h.setCodexResponse("thread/backgroundTerminals/list", async params => {
            events.push({list: params});
            const cursor = (params as {cursor: string | null}).cursor;
            return {data: [{itemId: cursor === null ? "one" : "two", processId: cursor === null ? "1" : "2", command: "sleep"}],
                nextCursor: cursor === null ? "next" : null};
        });
        h.setCodexResponse("thread/backgroundTerminals/terminate", async params => {
            events.push({terminate: params});
            await stopping;
            return {terminated: true};
        });
        h.setCodexResponse("thread/unsubscribe", async () => { events.push("unsubscribe"); return {status: "unsubscribed"}; });
        h.setCodexResponse("thread/archive", async () => { events.push("archive"); return {}; });
        const closed = h.request(method, {sessionId}).then(result => { events.push("response"); return result; });
        try {
            await vi.waitFor(() => expect(events).toHaveLength(3));
            expect(events).toEqual([
                {list: {threadId: sessionId, cursor: null}},
                {list: {threadId: sessionId, cursor: "next"}},
                {terminate: {threadId: sessionId, processId: "1"}},
            ]);
            release();
            await expect(closed).resolves.toEqual({});
            expect(events.slice(3)).toEqual([
                {terminate: {threadId: sessionId, processId: "2"}}, "unsubscribe",
                ...(method === "session/delete" ? ["archive"] : []), "response",
            ]);
            const before = events.length;
            await expect(h.request("session/close", {sessionId})).resolves.toEqual({});
            expect(events).toHaveLength(before);
            await expect(h.request("session/close", {sessionId: "not-a-codex-id"})).resolves.toEqual({});
            expect(events).toHaveLength(before);
        } finally { release(); await closed.catch(() => {}); h.connection.close(); }
    });
});

describe("Background cleanup failures", () => {
    it("cleans up verified child processes without acting on foreign ownership", async () => {
        const h = await connectSession();
        const threads: string[] = [];
        for (const id of ["child", "foreign"]) {
            h.emit(itemStarted({type: "subAgentActivity", id: `activity-${id}`, model: null, reasoningEffort: null,
                agentThreadId: id, agentPath: `/root/${id}`, kind: "started"}));
            h.emit({method: "thread/started", params: {thread: {...createThread(), id,
                parentThreadId: id === "child" ? sessionId : "other-root"}}});
        }
        await h.waitForNotifications();
        h.setCodexResponse("thread/backgroundTerminals/list", async params => {
            threads.push((params as {threadId: string}).threadId);
            return {data: [{itemId: "command", processId: "1", command: "sleep"}], nextCursor: null};
        });
        const stopped: unknown[] = [];
        h.setCodexResponse("thread/backgroundTerminals/terminate", async params => {
            stopped.push(params);
            return {terminated: true};
        });
        try {
            await expect(h.request("session/close", {sessionId})).resolves.toEqual({});
            expect(threads).toEqual(["child", sessionId]);
            expect(stopped).toEqual([{threadId: "child", processId: "1"}, {threadId: sessionId, processId: "1"}]);
        } finally { h.connection.close(); }
    });

    it.each(["error", "false"] as const)("keeps a failed close retryable when termination returns %s", async failure => {
        const h = await connectSession();
        let running = true;
        h.setCodexResponse("thread/backgroundTerminals/list", async () => ({
            data: running ? [{itemId: "one", processId: "1", command: "sleep"}] : [], nextCursor: null,
        }));
        h.setCodexResponse("thread/backgroundTerminals/terminate", async () => {
            if (failure === "error") throw new Error("Stop failed");
            return {terminated: false};
        });
        const unsubscribed = vi.fn(async () => ({status: "unsubscribed"}));
        h.setCodexResponse("thread/unsubscribe", unsubscribed);
        try {
            await expect(h.request("session/close", {sessionId})).rejects.toMatchObject({code: -32603});
            expect(unsubscribed).not.toHaveBeenCalled();
            expect(h.agent.getSessionState(sessionId)).toHaveProperty("sessionId", sessionId);
            h.setCodexResponse("thread/backgroundTerminals/terminate", async () => {
                running = false;
                return {terminated: true};
            });
            await expect(h.request("session/close", {sessionId})).resolves.toEqual({});
            expect(unsubscribed).toHaveBeenCalledOnce();
        } finally { h.connection.close(); }
    });

    it("accepts a process disappearing before terminate without reporting a failed close", async () => {
        const h = await connectSession();
        let listed = false;
        h.setCodexResponse("thread/backgroundTerminals/list", async () => {
            const data = listed ? [] : [{itemId: "one", processId: "1", command: "sleep"}];
            listed = true;
            return {data, nextCursor: null};
        });
        h.setCodexResponse("thread/backgroundTerminals/terminate", async () => ({terminated: false}));
        try {
            await expect(h.request("session/close", {sessionId})).resolves.toEqual({});
        } finally { h.connection.close(); }
    });
});
