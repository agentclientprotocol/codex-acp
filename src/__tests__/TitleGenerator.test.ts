import {describe, expect, it, vi} from "vitest";
import {TitleGenerator} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {deferred} from "./acp-test-utils";

function createGenerator(client: Partial<CodexAppServerClient>, publishFallback: (text: string) => Promise<void> = async () => {}) {
    return new TitleGenerator(client as CodexAppServerClient, "thread-id", "/test/cwd", () => "unset", publishFallback);
}

describe("TitleGenerator.waitForIdle", () => {
    it("returns immediately when nothing is generating", async () => {
        const generator = createGenerator({});

        await expect(generator.waitForIdle(50)).resolves.toBeUndefined();
    });

    it.each(["before", "after"])("settles when the rename echo arrives %s the write acknowledgement", async when => {
        const turn = deferred<{turn: {status: "completed"; items: {type: string; text: string}[]}}>();
        const threadSetName = vi.fn(async () => {
            if (when === "before") generator.observeRename();
            return {};
        });
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(turn.promise),
            threadSetName,
        } as unknown as Partial<CodexAppServerClient>);

        generator.onUserMessage("hello");
        let settled = false;
        const idle = generator.waitForIdle(1_000).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        turn.resolve({turn: {status: "completed", items: [{type: "agentMessage", text: '{"title":"A short title"}'}]}});
        await vi.waitFor(() => expect(threadSetName).toHaveBeenCalledWith({threadId: "thread-id", name: "A short title"}));
        if (when === "after") {
            expect(settled).toBe(false);
            generator.observeRename();
        }
        await idle;
        expect(generator.isGenerating).toBe(false);
    });

    it("gives up after the timeout rather than holding the caller open", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(new Promise(() => {})),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onUserMessage("hello");

        await expect(generator.waitForIdle(20)).resolves.toBeUndefined();
    });

    it("publishes the fallback once when the title thread cannot start", async () => {
        const fallback = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
        const generator = createGenerator({
            threadStart: vi.fn().mockRejectedValue(new Error("no ephemeral threads")),
            runTurn: vi.fn(),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>, fallback);

        generator.onUserMessage("hello");

        await expect(generator.waitForIdle(5_000)).resolves.toBeUndefined();
        generator.onUserMessage("second prompt");
        expect(fallback.mock.calls).toEqual([["hello"]]);
    });
});

describe("TitleGenerator fallback", () => {
    it.each([
        {status: "failed", output: '{"title":"Partial title"}'},
        {status: "interrupted", output: '{"title":"Partial title"}'},
        {status: "completed", output: "invalid JSON"},
        {status: "completed", output: '{"title":null}'},
        {status: "completed", output: '{"title":"  "}'},
    ])("uses the prompt when a $status title turn returns $output", async ({status, output}) => {
        const fallback = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
        const threadSetName = vi.fn();
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockResolvedValue({turn: {status, items: [{type: "agentMessage", text: output}]}}),
            threadSetName,
        }, fallback);
        generator.onUserMessage("first prompt");
        await generator.waitForIdle(1_000);
        expect(threadSetName).not.toHaveBeenCalled();
        expect(fallback.mock.calls).toEqual([["first prompt"]]);
    });
});

describe("TitleGenerator prompt", () => {
    it("sends only the start of a long first message to the title model", async () => {
        const runTurn = vi.fn().mockResolvedValue({turn: {status: "completed", items: []}});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn,
        } as unknown as Partial<CodexAppServerClient>);

        // The cut falls between the two halves of the emoji.
        generator.onUserMessage("  ");
        generator.onUserMessage(`${"a".repeat(3_999)}\u{1F600}${"b".repeat(200_000)}`);
        await generator.waitForIdle(1_000);

        const text: string = runTurn.mock.calls[0]![0].input[0].text;
        expect(text.endsWith(`User's first message:\n${"a".repeat(3_999)}`)).toBe(true);
    });
});
