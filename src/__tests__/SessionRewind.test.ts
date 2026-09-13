import {describe, expect, it, vi} from "vitest";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {rewindSession} from "../SessionRewind";

describe("session rewind", () => {
    it("reverts the same Codex thread before the selected user turn", async () => {
        const client = {
            threadReadWithHistory: vi.fn().mockResolvedValue({
                thread: {
                    turns: [
                        {id: "turn-1", items: [{type: "userMessage", id: "user-1", content: [{type: "text", text: "one"}]}]},
                        {id: "turn-2", items: [{type: "userMessage", id: "user-2", content: [{type: "text", text: "two"}]}]},
                    ],
                },
            }),
            threadRevert: vi.fn().mockResolvedValue({}),
        } as unknown as CodexAppServerClient;

        const result = await rewindSession({
            sessionId: "thread-1",
            beforeMessage: {
                messageId: "user-2",
                messageFingerprint: "sha256:3fc4ccfe745870e2c0d99f71f30ff0656c8d1ed5d3f3b71b17a64d1c0d9a4f5f",
                messageOccurrence: 1,
            },
        }, client);

        expect(result).toEqual({rewound: true});
        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("resolves a restored message through its fingerprint occurrence", async () => {
        const client = {
            threadReadWithHistory: vi.fn().mockResolvedValue({
                thread: {
                    turns: [
                        {id: "turn-1", items: [{type: "userMessage", id: "new-1", content: [{type: "text", text: "repeat"}]}]},
                        {id: "turn-2", items: [{type: "userMessage", id: "new-2", content: [{type: "text", text: "repeat"}]}]},
                    ],
                },
            }),
            threadRevert: vi.fn().mockResolvedValue({}),
        } as unknown as CodexAppServerClient;

        const result = await rewindSession({
            sessionId: "thread-1",
            beforeMessage: {
                messageId: "stale-id",
                messageFingerprint: "sha256:25e2b6b106523880e27763084ffa6a0756335be0d7106022535365b9ad39b4b1",
                messageOccurrence: 2,
            },
        }, client);

        expect(result).toEqual({rewound: true});
        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-2"});
    });

    it("does not revert when the selected message is absent", async () => {
        const client = {
            threadReadWithHistory: vi.fn().mockResolvedValue({thread: {turns: []}}),
            threadRevert: vi.fn(),
        } as unknown as CodexAppServerClient;

        await expect(rewindSession({
            sessionId: "thread-1",
            beforeMessage: {
                messageId: "missing",
                messageFingerprint: `sha256:${"0".repeat(64)}`,
                messageOccurrence: 1,
            },
        }, client)).rejects.toThrow("Rewind message missing was not found");
        expect(client.threadRevert).not.toHaveBeenCalled();
    });
});
