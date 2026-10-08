import {describe, expect, it, vi} from "vitest";
import {TitleGenerator} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {deferred} from "./acp-test-utils";

function createGenerator(client: Partial<CodexAppServerClient>, sessionUsesOpenAiProvider = true) {
    return new TitleGenerator(
        client as CodexAppServerClient,
        "thread-id",
        "/test/cwd",
        () => "unset",
        () => sessionUsesOpenAiProvider,
    );
}

describe("TitleGenerator.waitForIdle", () => {
    it("returns immediately when nothing is generating", async () => {
        const generator = createGenerator({});

        await expect(generator.waitForIdle(50)).resolves.toBeUndefined();
    });

    it("waits for the rename echo notification before settling", async () => {
        const turn = deferred<{turn: {items: {type: string; text: string}[]}}>();
        const threadSetName = vi.fn().mockResolvedValue({});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(turn.promise),
            threadSetName,
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");
        let settled = false;
        const idle = generator.waitForIdle(5_000).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        turn.resolve({turn: {items: [{type: "agentMessage", text: '{"title":"A short title"}'}]}});
        // Flush the microtask chain (extract title -> threadSetName -> start
        // waiting for the echo) without resolving the echo itself yet.
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(threadSetName).toHaveBeenCalledWith({threadId: "thread-id", name: "A short title"});
        expect(settled).toBe(false);

        // The thread/name/updated notification for this rename arrives.
        generator.observeRename();
        await idle;
        expect(settled).toBe(true);
    });

    it("gives up after the timeout rather than holding the caller open", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(new Promise(() => {})),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(20)).resolves.toBeUndefined();
    });

    it("stops waiting once a failed generation has settled", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockRejectedValue(new Error("no ephemeral threads")),
            runTurn: vi.fn(),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(5_000)).resolves.toBeUndefined();
    });
});

describe("TitleGenerator prompt", () => {
    it("sends only the start of a long first message to the title model", async () => {
        const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn,
        } as unknown as Partial<CodexAppServerClient>);

        // The cut falls between the two halves of the emoji.
        generator.onTurnCompleted(`${"a".repeat(3_999)}\u{1F600}${"b".repeat(200_000)}`);
        await generator.waitForIdle(1_000);

        const text: string = runTurn.mock.calls[0]![0].input[0].text;
        expect(text.endsWith(`User's first message:\n${"a".repeat(3_999)}`)).toBe(true);
    });
});

describe("TitleGenerator model provider", () => {
    it("requests a title from the title model for a session on the OpenAI provider", async () => {
        const threadStart = vi.fn().mockResolvedValue({thread: {id: "ephemeral"}});
        const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
        const generator = createGenerator({threadStart, runTurn} as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");
        await generator.waitForIdle(1_000);

        expect(threadStart).toHaveBeenCalledWith({cwd: "/test/cwd", ephemeral: true});
        expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({threadId: "ephemeral", model: "gpt-5.6-luna"}));
    });

    it("starts no title thread or turn for a session on another provider", async () => {
        const threadStart = vi.fn().mockResolvedValue({thread: {id: "ephemeral"}});
        const runTurn = vi.fn().mockResolvedValue({turn: {items: []}});
        const generator = createGenerator({threadStart, runTurn} as unknown as Partial<CodexAppServerClient>, false);

        generator.onTurnCompleted("hello");
        generator.onTurnCompleted("second turn");
        await generator.waitForIdle(1_000);

        expect(threadStart).not.toHaveBeenCalled();
        expect(runTurn).not.toHaveBeenCalled();
    });
});
