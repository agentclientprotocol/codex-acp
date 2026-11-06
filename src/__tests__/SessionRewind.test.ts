import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {CodexAcpClient} from "../CodexAcpClient";
import {rewindSession, type SessionHistoryPoint} from "../SessionRewind";

function fingerprint(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const UNKNOWN_FINGERPRINT = `sha256:${"0".repeat(64)}`;

function userMessage(id: string, content: unknown[], clientId: string | null = null) {
    return {type: "userMessage", id, clientId, content};
}

function text(value: string) {
    return {type: "text", text: value, text_elements: []};
}

/** An app-server client whose thread has `turns`, with paginated history unless `historyMode` says otherwise. */
function historyClient(turns: unknown[], historyMode: "paginated" | "legacy" = "paginated") {
    const client = {
        threadRead: vi.fn().mockResolvedValue({thread: {historyMode, turns: []}}),
        threadPaginatedTurns: vi.fn().mockResolvedValue(turns),
        threadRevert: vi.fn().mockResolvedValue({}),
    };
    return client as typeof client & CodexAppServerClient;
}

function rewind(client: CodexAppServerClient, beforeMessage: Partial<SessionHistoryPoint>, resumeAtMessage?: SessionHistoryPoint) {
    return rewindSession({
        sessionId: "thread-1",
        beforeMessage: {messageId: "stale-id", messageFingerprint: UNKNOWN_FINGERPRINT, messageOccurrence: 1, ...beforeMessage},
        ...(resumeAtMessage ? {resumeAtMessage} : {}),
    }, client);
}

describe("session rewind", () => {
    it("reverts the same Codex thread before the selected user turn", async () => {
        const client = historyClient([
            {id: "turn-1", items: [userMessage("user-1", [text("one")])]},
            {id: "turn-2", items: [userMessage("user-2", [text("two")])]},
        ]);

        await expect(rewind(client, {messageId: "user-2"})).resolves.toEqual({rewound: true});
        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("resolves a restored message through its fingerprint occurrence", async () => {
        const client = historyClient([
            {id: "turn-1", items: [userMessage("new-1", [text("repeat")])]},
            {id: "turn-2", items: [userMessage("new-2", [text("repeat")])]},
        ]);

        await rewind(client, {messageFingerprint: fingerprint("repeat"), messageOccurrence: 2});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("matches the client message id that v2 replays a message under", async () => {
        const client = historyClient([
            {id: "turn-1", items: [userMessage("item-1", [text("one")], "client-1")]},
            {id: "turn-2", items: [userMessage("item-2", [text("two")], "client-2")]},
        ]);

        await rewind(client, {messageId: "client-2"});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("prefers the exact segmented message id over its protocol id fallback", async () => {
        const client = historyClient([
            {id: "turn-1", items: [userMessage("user-1", [text("fallback")])]},
            {id: "turn-2", items: [userMessage("user-1:segment:0", [text("exact")])]},
        ]);

        await rewind(client, {messageId: "user-1:segment:0"});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("does not fingerprint history when an exact message id is found", async () => {
        const unreadableItem = Object.defineProperty({type: "userMessage", id: "other", clientId: null}, "content", {
            enumerable: true,
            get: () => {
                throw new Error("fingerprint fallback should not run");
            },
        });
        const client = historyClient([
            {id: "turn-1", items: [unreadableItem]},
            {id: "turn-2", items: [userMessage("exact", [text("selected")])]},
        ]);

        await rewind(client, {messageId: "exact"});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("uses the visible replay text when fingerprinting multimodal and skill inputs", async () => {
        const client = historyClient([{
            id: "turn-1",
            items: [userMessage("new-id", [
                text("look"),
                {type: "image", url: "https://example.com/image.png"},
                {type: "skill", name: "review", path: "/tmp/SKILL.md"},
            ])],
        }]);

        await rewind(client, {
            messageFingerprint: fingerprint("look[@image](https://example.com/image.png)skill:review (/tmp/SKILL.md)"),
        });

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-1"});
    });

    it("fingerprints a file mention of a prompt as the link text that replay sends", async () => {
        // A prompt `look at <resource_link foo.txt> please` is stored as three text inputs.
        const client = historyClient([{
            id: "turn-1",
            items: [userMessage("new-id", [text("look at "), text("[@foo.txt](file:///work/foo.txt)"), text(" please")])],
        }]);

        await rewind(client, {messageFingerprint: fingerprint("look at [@foo.txt](file:///work/foo.txt) please")});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-1"});
    });

    it("leaves a native attachment that replay sends as a resource link out of the fingerprint", async () => {
        const client = historyClient([{
            id: "turn-1",
            items: [userMessage("new-id", [text("read this"), {type: "mention", name: "foo.txt", path: "/work/foo.txt"}])],
        }]);

        await rewind(client, {messageFingerprint: fingerprint("read this")});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-1"});
    });

    it("reports that a legacy-history thread cannot be rewound without reading its turns", async () => {
        const client = historyClient([], "legacy");

        await expect(rewind(client, {messageId: "user-2"})).rejects.toThrow("legacy history, which Codex cannot rewind");

        expect(client.threadPaginatedTurns).not.toHaveBeenCalled();
        expect(client.threadRevert).not.toHaveBeenCalled();
    });

    it("rejects rewinding a steer inside an existing turn", async () => {
        const client = historyClient([{
            id: "turn-1",
            items: [
                userMessage("user-1", [text("first")]),
                {type: "agentMessage", id: "assistant-1", text: "working"},
                userMessage("steer-1", [text("steer")]),
            ],
        }]);

        await expect(rewind(client, {messageId: "steer-1"}, {
            messageId: "assistant-1",
            messageFingerprint: UNKNOWN_FINGERPRINT,
            messageOccurrence: 1,
        })).rejects.toThrow("does not start a turn");
        expect(client.threadRevert).not.toHaveBeenCalled();
    });

    it("rewinds a turn whose first user message follows other items", async () => {
        const client = historyClient([
            {id: "turn-1", items: [userMessage("user-1", [text("one")])]},
            {id: "turn-2", items: [{type: "contextCompaction", id: "compact-1"}, userMessage("user-2", [text("two")])]},
        ]);

        await rewind(client, {messageId: "user-2"});

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("does not revert when the selected message is absent", async () => {
        const client = historyClient([]);

        await expect(rewind(client, {messageId: "missing"})).rejects.toThrow("Rewind message missing was not found");
        expect(client.threadRevert).not.toHaveBeenCalled();
    });

    it("drains queued session notifications before acknowledging rewind", async () => {
        const appServerClient = historyClient([{id: "turn-1", items: [userMessage("user-1", [text("one")])]}]);
        const client = new CodexAcpClient(appServerClient);
        const waitForNotifications = vi.spyOn(client, "waitForSessionNotifications").mockResolvedValue();

        await client.rewindSession({
            sessionId: "thread-1",
            beforeMessage: {messageId: "user-1", messageFingerprint: UNKNOWN_FINGERPRINT, messageOccurrence: 1},
        });

        expect(waitForNotifications).toHaveBeenCalledWith("thread-1");
        expect(appServerClient.threadRevert).toHaveBeenCalledBefore(waitForNotifications);
    });
});
