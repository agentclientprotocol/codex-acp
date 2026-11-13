import {afterEach, describe, expect, it, vi} from "vitest";
import {connectSession, createThread, sessionId} from "./v2-prompt-harness";
import {MAX_SESSION_TITLE_LENGTH} from "../../SessionTitle";

describe.each([1, 2] as const)("ACP v%s session/set_title", version => {
    let close: (() => void) | null = null;
    afterEach(() => { close?.(); close = null; });

    it.each([sessionId, "saved-thread"])("persists and returns the normalized title of %s without AIR", async target => {
        const h = await connectSession(version);
        close = () => h.connection.close();
        const writes: unknown[] = [];
        let written!: () => void;
        const write = new Promise<void>(resolve => { written = resolve; });
        h.setCodexResponse("thread/name/set", async params => {
            writes.push(params);
            await write;
            return {};
        });
        const requested = `  New\n title ${"x".repeat(300)}`;
        let replied = false;
        const pending = h.request("session/set_title", {sessionId: target, title: requested, _meta: null})
            .then(result => { replied = true; return result; });
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(replied).toBe(false);
        written();
        const response = await pending;
        expect(response.title).toHaveLength(MAX_SESSION_TITLE_LENGTH);
        expect(response.title).toMatch(/^New title x+…$/);
        expect(writes).toEqual([{threadId: target, name: response.title}]);
        h.setCodexResponse("thread/list", async () => ({
            data: [{...createThread(), id: target, name: response.title}], nextCursor: null,
        }));
        expect((await h.request("session/list", {})).sessions[0].title).toBe(response.title);
        if (target === sessionId) {
            await vi.waitFor(() => expect(h.scopedUpdates).toContainEqual({
                sessionId, update: {sessionUpdate: "session_info_update", title: response.title},
            }));
        } else {
            expect(h.scopedUpdates.some(entry => entry.sessionId === target)).toBe(false);
        }
    });

    it.each([undefined, null, 123, "", " \n "])("rejects an invalid title (%j) without a write", async title => {
        const h = await connectSession(version);
        close = () => h.connection.close();
        const write = vi.fn(async () => ({}));
        h.setCodexResponse("thread/name/set", write);
        await expect(h.request("session/set_title", {sessionId, title})).rejects.toMatchObject({code: -32602});
        expect(write).not.toHaveBeenCalled();
    });

    it("reports missing sessions and persistence failures rather than succeeding", async () => {
        const h = await connectSession(version);
        close = () => h.connection.close();
        h.setCodexResponse("thread/name/set", async () => { throw new Error("no rollout found for thread id missing"); });
        h.setCodexResponse("thread/read", async () => { throw new Error("thread not found: missing"); });
        await expect(h.request("session/set_title", {sessionId: "missing", title: "New"}))
            .rejects.toMatchObject({code: -32002, data: {sessionId: "missing"}});
        h.setCodexResponse("thread/name/set", async () => { throw new Error("disk write failed"); });
        await expect(h.request("session/set_title", {sessionId, title: "New"}))
            .rejects.toMatchObject({code: -32603, data: {details: "disk write failed"}});
    });
});
