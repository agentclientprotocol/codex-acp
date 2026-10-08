import {describe, expect, it, vi} from "vitest";
import type {Turn} from "../app-server/v2/Turn";
import {
    SESSION_QUEUE_ACTIONS, SESSION_QUEUE_METHOD, parseSessionQueueRequest,
    probeSessionQueueSupport, runSessionQueue, sessionQueueCapability,
    type NativeQueueInput, type SessionQueueNative, type SessionQueueSupport,
} from "../SessionQueue";

const input: NativeQueueInput[] = [
    {type: "text", text: "正文", text_elements: [{byteRange: {start: 0, end: 6}, placeholder: null}]},
    {type: "text", text: "  keep whitespace  "},
    {type: "image", fileId: "file-id", detail: "original"},
    {type: "image", url: "data:image/png;base64,AA==", detail: null},
    {type: "localImage", path: "C:\\a.png"},
    {type: "audio", url: "data:audio/wav;base64,AA=="},
    {type: "localAudio", path: "C:\\a.wav"},
    {type: "skill", name: "skill", path: "C:\\SKILL.md"},
    {type: "mention", name: "file", path: "C:\\file.txt"},
];
const support: SessionQueueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
const queued = {id: "native-q", input, clientUserMessageId: "client-id", futureNativeField: {keep: true}};
const turn: Turn = {id: "native-turn", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null};

function fixture() {
    const native = {
        list: vi.fn<SessionQueueNative["list"]>().mockResolvedValue({data: [queued], nextCursor: "opaque-next"}),
        add: vi.fn<SessionQueueNative["add"]>().mockResolvedValue({queuedSubmission: queued}),
        update: vi.fn<SessionQueueNative["update"]>().mockResolvedValue({queuedSubmission: queued}),
        delete: vi.fn<SessionQueueNative["delete"]>().mockResolvedValue({deleted: false}),
        reorder: vi.fn<SessionQueueNative["reorder"]>().mockResolvedValue({}),
        start: vi.fn<SessionQueueNative["start"]>().mockResolvedValue({turn}),
    };
    const dependencies = {sessionId: "session", support, native};
    return {native, dependencies, run: (request: unknown) => runSessionQueue(request, dependencies)};
}

describe("session queue capability", () => {
    it.each(["0.154.0", "0.159.3", "0.160.0", "0.160.1-preview.1", "codex 0.160.1", "2.1.1-preview", "", null, undefined])(
        "does not probe or advertise unknown/old/unverified native %s", async version => {
            const probe = vi.fn(async () => true);
            const result = await probeSessionQueueSupport(version, probe);
            expect(probe).not.toHaveBeenCalled();
            expect(result.actions).toEqual([]);
            expect(sessionQueueCapability(result)).toBeUndefined();
        },
    );
    it("advertises only each action positively confirmed on the running native", async () => {
        const result = await probeSessionQueueSupport("0.160.1", async action => {
            if (action === "start") throw new Error("probe transport failed");
            return action === "list";
        });
        expect(sessionQueueCapability(result)).toEqual({version: 1, method: SESSION_QUEUE_METHOD, actions: ["list"]});
        expect(Object.isFrozen(result.actions)).toBe(true);
    });
    it.each(["0.160.1", "0.161.0", "1.0.0"])("still requires positive evidence for %s", async version => {
        const result = await probeSessionQueueSupport(version, async () => false);
        expect(sessionQueueCapability(result)).toBeUndefined();
    });
    it("rejects an old native support record even if its actions were supplied", async () => {
        const f = fixture();
        f.dependencies.support = {nativeVersion: "0.154.0", actions: SESSION_QUEUE_ACTIONS};
        await expect(f.run({sessionId: "session", action: "start"})).resolves.toEqual({status: "unsupported"});
        expect(f.native.start).not.toHaveBeenCalled();
    });
});

describe("session queue native boundary", () => {
    it("keeps native multimodal input, omission, IDs, and unknown RESULT fields", async () => {
        const f = fixture();
        const result = {queuedSubmission: queued, nativeExtra: {revision: "native-owned"}};
        f.native.add.mockResolvedValue(result);
        await expect(f.run({sessionId: "session", action: "add", input, clientUserMessageId: "client-id"}))
            .resolves.toEqual({status: "ok", result});
        expect(f.native.add).toHaveBeenCalledExactlyOnceWith({threadId: "session", input, clientUserMessageId: "client-id"});
        expect(f.native.add.mock.calls[0]![0].input[1]).not.toHaveProperty("text_elements");
        expect(result.queuedSubmission.id).toBe("native-q");
    });
    it("preserves list pagination, nulls, and the native result object", async () => {
        const f = fixture();
        const result = {data: [queued], nextCursor: "opaque-next", total: 200};
        f.native.list.mockResolvedValue(result);
        const response = await f.run({sessionId: "session", action: "list", cursor: "opaque-in", limit: 0});
        expect(response.status === "ok" && response.result).toBe(result);
        expect(f.native.list).toHaveBeenLastCalledWith({threadId: "session", cursor: "opaque-in", limit: 0});
        await f.run({sessionId: "session", action: "list", cursor: null, limit: null});
        expect(f.native.list).toHaveBeenLastCalledWith({threadId: "session", cursor: null, limit: null});
        await f.run({sessionId: "session", action: "list"});
        expect(f.native.list).toHaveBeenLastCalledWith({threadId: "session"});
    });
    it("updates only the named native submission without replacing its client ID", async () => {
        const f = fixture();
        await expect(f.run({sessionId: "session", action: "update", queuedSubmissionId: "q", input}))
            .resolves.toEqual({status: "ok", result: {queuedSubmission: queued}});
        expect(f.native.update).toHaveBeenCalledExactlyOnceWith({threadId: "session", queuedSubmissionId: "q", input});
    });
    it("keeps delete=false and does not invent successful removal", async () => {
        const f = fixture();
        await expect(f.run({sessionId: "session", action: "delete", queuedSubmissionId: "gone"}))
            .resolves.toEqual({status: "ok", result: {deleted: false}});
        expect(f.native.delete).toHaveBeenCalledExactlyOnceWith({threadId: "session", queuedSubmissionId: "gone"});
    });
    it("delegates native ordering and membership validation without local reordering", async () => {
        const f = fixture();
        const ids = ["third", "first"];
        await expect(f.run({sessionId: "session", action: "reorder", queuedSubmissionIds: ids}))
            .resolves.toEqual({status: "ok", result: {}});
        expect(f.native.reorder).toHaveBeenCalledExactlyOnceWith({threadId: "session", queuedSubmissionIds: ids});
        expect(f.native.list).not.toHaveBeenCalled();
    });
    it.each([{}, {queuedSubmissionId: null}, {queuedSubmissionId: "q"}])("only fake-starts once with native selector %j", async selector => {
        const f = fixture();
        await expect(f.run({sessionId: "session", action: "start", ...selector}))
            .resolves.toEqual({status: "ok", result: {turn}});
        expect(f.native.start).toHaveBeenCalledExactlyOnceWith({threadId: "session", ...selector});
        expect(f.native.delete).not.toHaveBeenCalled();
    });
    it.each(SESSION_QUEUE_ACTIONS)("never accesses another session for %s", async action => {
        const f = fixture();
        const requests = {
            list: {}, add: {input, clientUserMessageId: "id"}, update: {input, queuedSubmissionId: "id"},
            delete: {queuedSubmissionId: "id"}, reorder: {queuedSubmissionIds: []}, start: {},
        };
        await expect(f.run({sessionId: "other", action, ...requests[action]})).rejects.toThrow("bound session");
        for (const callback of Object.values(f.native)) expect(callback).not.toHaveBeenCalled();
    });
    it("rejects unproven start even when list was positively probed", async () => {
        const f = fixture();
        f.dependencies.support = await probeSessionQueueSupport("0.160.1", async action => action === "list");
        await expect(f.run({sessionId: "session", action: "start"})).resolves.toEqual({status: "unsupported"});
        expect(f.native.start).not.toHaveBeenCalled();
    });
    it("reports a definitive method-not-found without retry or fallback", async () => {
        const f = fixture();
        f.native.start.mockRejectedValue({code: -32601, message: "Method not found"});
        await expect(f.run({sessionId: "session", action: "start"})).resolves.toEqual({status: "unsupported"});
        expect(f.native.start).toHaveBeenCalledTimes(1);
    });
    it.each([
        {code: -32602, message: "thread not found"},
        {code: -32603, message: "storage failed"},
        new Error("response lost after native commit"),
    ])("propagates failures without replaying an uncertain mutation", async error => {
        const f = fixture();
        f.native.add.mockRejectedValue(error);
        await expect(f.run({sessionId: "session", action: "add", input, clientUserMessageId: "client-id"})).rejects.toBe(error);
        expect(f.native.add).toHaveBeenCalledTimes(1);
        expect(f.native.list).not.toHaveBeenCalled();
    });
});

describe("session queue input validation", () => {
    it.each([
        null, [], "list", {},
        {sessionId: "session", action: "thread/delete"},
        {sessionId: "session", action: "list", threadId: "other"},
        {sessionId: "session", action: "list", method: "thread/delete"},
        {sessionId: "session", action: "list", params: {threadId: "other"}},
        {sessionId: "session", action: "list", limit: -1},
        {sessionId: "session", action: "list", limit: 1.5},
        {sessionId: "session", action: "list", limit: 0x1_0000_0000},
        {sessionId: "session", action: "list", cursor: 1},
        {sessionId: " ", action: "list"},
        {sessionId: "session\n", action: "list"},
        {sessionId: "session", action: "add", input},
        {sessionId: "session", action: "add", input, clientUserMessageId: "id", revision: 1},
        {sessionId: "session", action: "start", input},
        {sessionId: "session", action: "start", queuedSubmissionId: ""},
        {sessionId: "session", action: "reorder", queuedSubmissionIds: [null]},
        {sessionId: "session", action: "update", input, queuedSubmissionId: "q", clientUserMessageId: "replacement"},
    ])("rejects malformed/extra fields before any native call: %j", async request => {
        const f = fixture();
        await expect(f.run(request)).rejects.toThrow("Invalid session queue request");
        for (const callback of Object.values(f.native)) expect(callback).not.toHaveBeenCalled();
    });
    it.each([
        {type: "text", text: 42},
        {type: "text", text: "x", text_elements: [{byteRange: {start: -1, end: 1}}]},
        {type: "text", text: "x", text_elements: [{byteRange: {start: 0, end: 1}, placeholder: 7}]},
        {type: "image", url: "data:x", fileId: "ambiguous"},
        {type: "image", url: "data:x", detail: "unlimited"},
        {type: "image", fileId: "x", threadId: "other"},
        {type: "toolOutput", text: "inject"},
        {type: "localImage", path: 42},
    ])("rejects unknown/malformed native input: %j", block => {
        expect(() => parseSessionQueueRequest({sessionId: "session", action: "add", input: [block], clientUserMessageId: "id"}))
            .toThrow("Invalid session queue request");
    });
    it("does not echo rejected prompt/URL contents in errors", () => {
        try {
            parseSessionQueueRequest({sessionId: "session", action: "add", input: [{type: "unknown", secret: "sensitive"}], clientUserMessageId: "id"});
            expect.fail("should reject");
        } catch (error) {
            expect(String(error)).not.toContain("sensitive");
        }
    });
});
