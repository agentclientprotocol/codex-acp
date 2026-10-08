import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {rewindSession, type SessionHistoryPoint} from "../SessionRewind";
import {CodexAcpClient} from "../CodexAcpClient";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {Thread, Turn, ThreadItem, UserInput} from "../app-server/v2";
import {userInputVisibleText} from "../UserInputContent";

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const point = (id: string, text: string, occurrence = 1): SessionHistoryPoint => ({messageId: id, messageFingerprint: hash(text), messageOccurrence: occurrence});
function turn(id: string, text: string, items: ThreadItem[] = []): Turn {
    return {id, items: [{type: "userMessage", id: `u-${id}`, clientId: null, content: [{type: "text", text, text_elements: []}]}, ...items], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null};
}
function answer(id: string, text: string): ThreadItem {
    return {type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null};
}
function fixture(turns: Turn[], mode: "legacy" | "paginated" = "paginated") {
    const thread = {id: "session", historyMode: mode, turns} as Thread;
    const client = {
        threadReadWithHistory: vi.fn(async () => ({thread: structuredClone(thread)})),
        threadRevert: vi.fn(async ({beforeTurnId}: {beforeTurnId: string}) => {
            thread.turns = thread.turns.slice(0, thread.turns.findIndex(t => t.id === beforeTurnId));
            return {thread: {...thread, turns: []}};
        }),
        threadRollback: vi.fn(async ({numTurns}: {numTurns: number}) => {
            thread.turns = thread.turns.slice(0, -numTurns);
            return {thread};
        }),
    };
    const run = (beforeMessage: SessionHistoryPoint, resumeAtMessage?: SessionHistoryPoint, hooks?: Parameters<typeof rewindSession>[2]) =>
        rewindSession({sessionId: "session", beforeMessage, ...(resumeAtMessage ? {resumeAtMessage} : {})}, client as unknown as CodexAppServerClient, hooks);
    return {client, thread, run};
}

describe("session rewind", () => {
    it.each([0, 1, 2])("keeps the same ID and precise prefix before turn %i", async index => {
        const f = fixture([turn("1", "one"), turn("2", "two"), turn("3", "three")]);
        await expect(f.run(point(`u-${index + 1}`, ["one", "two", "three"][index]!))).resolves.toEqual({rewound: true});
        expect(f.thread.id).toBe("session");
        expect(f.thread.turns).toHaveLength(index);
        expect(f.client.threadRollback).not.toHaveBeenCalled();
    });
    it("supports repeated edits after the retained prefix is persisted", async () => {
        const f = fixture([turn("1", "one"), turn("2", "two")]);
        await f.run(point("u-2", "two"));
        f.thread.turns.push(turn("3", "replacement"));
        await f.run(point("u-3", "replacement"));
        expect(f.thread.turns.map(t => t.id)).toEqual(["1"]);
    });
    it("rejects stale content even when the exact ID still exists", async () => {
        const f = fixture([turn("1", "new")]);
        await expect(f.run(point("u-1", "old"))).rejects.toThrow("fingerprint changed");
        expect(f.client.threadRevert).not.toHaveBeenCalled();
    });
    it("prefers the exact segmented ID before its protocol ID fallback", async () => {
        const a = turn("1", "fallback"), b = turn("2", "exact");
        b.items[0]!.id = "u-1:segment:0";
        const f = fixture([a, b]);
        await f.run(point("u-1:segment:0", "exact"));
        expect(f.thread.turns.map(t => t.id)).toEqual(["1"]);
    });
    it("resolves a unique restored text fingerprint", async () => {
        const f = fixture([turn("1", "one")]);
        await f.run(point("stale-id", "one"));
        expect(f.thread.turns).toEqual([]);
    });
    it("requires a current retained boundary for repeated fingerprint fallback", async () => {
        const f = fixture([turn("1", "repeat", [answer("a-1", "answer")]), turn("2", "repeat")]);
        await expect(f.run(point("stale", "repeat", 2))).rejects.toThrow("retained boundary");
        expect(f.client.threadRevert).not.toHaveBeenCalled();
        await f.run(point("stale", "repeat", 2), point("a-1", "answer"));
        expect(f.thread.turns.map(t => t.id)).toEqual(["1"]);
    });
    it("rejects a stale retained boundary without mutating", async () => {
        const f = fixture([turn("1", "one", [answer("a-1", "answer")]), turn("2", "two")]);
        await expect(f.run(point("u-2", "two"), point("deleted-anchor", "answer"))).rejects.toThrow("boundary changed");
        expect(f.client.threadRevert).not.toHaveBeenCalled();
    });
    it("rejects midturn steering rather than discarding the containing turn", async () => {
        const f = fixture([turn("1", "one", [answer("a-1", "working"), ...turn("steer", "steer").items])]);
        await expect(f.run(point("u-steer", "steer"))).rejects.toThrow("does not start a turn");
        expect(f.client.threadRevert).not.toHaveBeenCalled();
    });
    it("shares current replay text for multimodal and skill inputs", async () => {
        const f = fixture([turn("1", "look")]);
        const content: UserInput[] = [{type:"text", text:"look", text_elements:[]}, {type:"image", url:"https://example.test/i.png"}, {type:"skill", name:"review", path:"/tmp/skill"}];
        (f.thread.turns[0]!.items[0] as Extract<ThreadItem, {type:"userMessage"}>).content = content;
        await f.run(point("stale", userInputVisibleText(content)));
        expect(f.thread.turns).toEqual([]);
    });
    it("requires exact identity when replay text omits a resource", async () => {
        const f = fixture([turn("1", "")]);
        (f.thread.turns[0]!.items[0] as Extract<ThreadItem, {type:"userMessage"}>).content = [{type:"mention", name:"file", path:"/tmp/file"}];
        await expect(f.run(point("stale", ""))).rejects.toThrow("attachment identity");
        await f.run(point("u-1", ""));
        expect(f.thread.turns).toEqual([]);
    });
    it("uses rollback only for explicit legacy metadata", async () => {
        const f = fixture([turn("1", "one"), turn("2", "two"), turn("3", "three")], "legacy");
        await f.run(point("u-2", "two"));
        expect(f.client.threadRollback).toHaveBeenCalledWith({threadId: "session", numTurns: 2});
        expect(f.client.threadRevert).not.toHaveBeenCalled();
    });
    it.each([{}, {code:-32601}, new Error("legacy rollback suggested"), new Error("reload failed")])("never falls back based on a revert error shape %j", async error => {
        const f = fixture([turn("1", "one")]);
        f.client.threadRevert.mockRejectedValue(error);
        await expect(f.run(point("u-1", "one"))).rejects.toEqual(error);
        expect(f.client.threadRollback).not.toHaveBeenCalled();
    });
    it("rejects unknown native history mode before dispatch", async () => {
        const f = fixture([turn("1", "one")]);
        (f.thread as {historyMode: unknown}).historyMode = undefined;
        await expect(f.run(point("u-1", "one"))).rejects.toThrow("Unknown history mode");
        expect(f.client.threadRevert).not.toHaveBeenCalled();
    });
    it("validates before cancelling and rejects a changed prefix after settlement", async () => {
        const f = fixture([turn("1", "one"), turn("2", "two")]);
        const stop = vi.fn(async () => {f.thread.turns[0] = turn("replaced", "other");});
        await expect(f.run(point("u-2", "two"), undefined, {beforeMutation:stop})).rejects.toThrow("history changed");
        expect(stop).toHaveBeenCalledOnce();
        expect(f.client.threadRevert).not.toHaveBeenCalled();
        await expect(f.run(point("missing", "absent"), undefined, {beforeMutation:stop})).rejects.toThrow("not found");
        expect(stop).toHaveBeenCalledOnce();
    });
    it("checks the actual retained prefix instead of trusting empty response turns", async () => {
        const f = fixture([turn("1", "one"), turn("2", "two")]);
        f.client.threadRevert.mockResolvedValue({thread:{...f.thread, turns:[]}});
        await expect(f.run(point("u-2", "two"))).rejects.toThrow("expected prefix");
    });
    it("drains native notifications after persisted-prefix verification", async () => {
        const f = fixture([turn("1", "one")]);
        const client = new CodexAcpClient(f.client as unknown as CodexAppServerClient);
        const drain = vi.spyOn(client, "waitForSessionNotifications").mockResolvedValue();
        await client.rewindSession({sessionId:"session",beforeMessage:point("u-1","one")});
        expect(f.client.threadRevert).toHaveBeenCalledBefore(drain);
        expect(drain).toHaveBeenCalledWith("session");
    });
});
