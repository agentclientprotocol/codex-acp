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

    it("uses the visible replay text when fingerprinting multimodal and skill inputs", async () => {
        const client = {
            threadReadWithHistory: vi.fn().mockResolvedValue({
                thread: {
                    historyMode: "paginated",
                    turns: [{
                        id: "turn-1",
                        items: [{
                            type: "userMessage",
                            id: "new-id",
                            content: [
                                {type: "text", text: "look"},
                                {type: "image", url: "https://example.com/image.png"},
                                {type: "skill", name: "review", path: "/tmp/SKILL.md"},
                            ],
                        }],
                    }],
                },
            }),
            threadRevert: vi.fn().mockResolvedValue({}),
        } as unknown as CodexAppServerClient;

        await rewindSession({
            sessionId: "thread-1",
            beforeMessage: {
                messageId: "stale-id",
                messageFingerprint: "sha256:d0425f232dd6a5d6a18eee0fb305ff976368b93fb5ad3da67a4b41d919f7e2de",
                messageOccurrence: 1,
            },
        }, client);

        expect(client.threadRevert).toHaveBeenCalledWith({threadId: "thread-1", beforeTurnId: "turn-1"});
    });

    it("uses turn-count rollback for legacy thread history", async () => {
        const client = {
            threadReadWithHistory: vi.fn().mockResolvedValue({
                thread: {
                    historyMode: "legacy",
                    turns: [
                        {id: "turn-1", items: [{type: "userMessage", id: "user-1", content: [{type: "text", text: "one"}]}]},
                        {id: "turn-2", items: [{type: "userMessage", id: "user-2", content: [{type: "text", text: "two"}]}]},
                        {id: "turn-3", items: [{type: "userMessage", id: "user-3", content: [{type: "text", text: "three"}]}]},
                    ],
                },
            }),
            threadRollback: vi.fn().mockResolvedValue({}),
            threadRevert: vi.fn(),
        } as unknown as CodexAppServerClient;

        await rewindSession({
            sessionId: "thread-1",
            beforeMessage: {
                messageId: "user-2",
                messageFingerprint: "sha256:3fc4ccfe745870e2c0d99f71f30ff0656c8d1ed5d3f3b71b17a64d1c0d9a4f5f",
                messageOccurrence: 1,
            },
        }, client);

        expect(client.threadRollback).toHaveBeenCalledWith({threadId: "thread-1", numTurns: 2});
        expect(client.threadRevert).not.toHaveBeenCalled();
    });

    it("rejects rewinding a steer inside an existing turn", async () => {
        const client = {
            threadReadWithHistory: vi.fn().mockResolvedValue({
                thread: {
                    historyMode: "paginated",
                    turns: [{
                        id: "turn-1",
                        items: [
                            {type: "userMessage", id: "user-1", content: [{type: "text", text: "first"}]},
                            {type: "agentMessage", id: "assistant-1", text: "working"},
                            {type: "userMessage", id: "steer-1", content: [{type: "text", text: "steer"}]},
                        ],
                    }],
                },
            }),
            threadRevert: vi.fn(),
        } as unknown as CodexAppServerClient;

        await expect(rewindSession({
            sessionId: "thread-1",
            beforeMessage: {
                messageId: "steer-1",
                messageFingerprint: "sha256:57fce44d7c6df51ad8525da1580a246e9d1142d79d1d1f176b1d29643d61ed44",
                messageOccurrence: 1,
            },
            resumeAtMessage: {
                messageId: "assistant-1",
                messageFingerprint: `sha256:${"0".repeat(64)}`,
                messageOccurrence: 1,
            },
        }, client)).rejects.toThrow("does not start a turn");
        expect(client.threadRevert).not.toHaveBeenCalled();
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
