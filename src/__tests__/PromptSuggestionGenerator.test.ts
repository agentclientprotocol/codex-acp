import {describe, expect, it, vi} from "vitest";
import {PromptSuggestionGenerator, promptSuggestionsEnabled} from "../PromptSuggestionGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {deferred} from "./acp-test-utils";

type SampleResult = {sourceTurnId: string; responseId: string; text: string | null; inputTokens: null; cachedInputTokens: null; outputTokens: null};

function sample(text: string | null): SampleResult {
    return {sourceTurnId: "t", responseId: "r", text, inputTokens: null, cachedInputTokens: null, outputTokens: null};
}

function suggestionSample(suggestion: string | null): SampleResult {
    return sample(JSON.stringify({suggestion}));
}

function createGenerator(threadSample: ReturnType<typeof vi.fn>) {
    const publish = vi.fn().mockResolvedValue(undefined);
    const client = {threadSample} as unknown as CodexAppServerClient;
    return {generator: new PromptSuggestionGenerator(client, publish), publish, threadSample};
}

async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("PromptSuggestionGenerator", () => {
    /** The parsed suggestion is trimmed and published; the sample targets the finished turn of the session thread. */
    it("publishes the parsed suggestion", async () => {
        const {generator, publish, threadSample} = createGenerator(vi.fn().mockResolvedValue(suggestionSample("  Run the tests  ")));

        generator.onTurnCompleted("thread-1", "turn-1");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("Run the tests"));

        const params = threadSample.mock.calls[0]![0] as {threadId: string; expectedTurnId: string; prompt: string; effort: string};
        expect({...params, prompt: undefined}).toEqual({threadId: "thread-1", expectedTurnId: "turn-1", prompt: undefined, effort: "high"});
        await expect(params.prompt).toMatchFileSnapshot("data/prompt-suggestion-sample-prompt.txt");
    });

    /** Blank, missing, malformed or non-string output publishes nothing when nothing is held. */
    it.each([
        ["blank suggestion", suggestionSample("   ")],
        ["null suggestion", suggestionSample(null)],
        ["null text", sample(null)],
        ["blank text", sample("  ")],
        ["malformed JSON", sample("not json")],
        ["non-string suggestion", sample(JSON.stringify({suggestion: 5}))],
    ])("does not publish for %s when nothing was published", async (_name, result) => {
        const {generator, publish, threadSample} = createGenerator(vi.fn().mockResolvedValue(result));

        generator.onTurnCompleted("thread", "turn");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalled());
        await flush();

        expect(publish).not.toHaveBeenCalled();
    });

    /** A null suggestion after a published one clears it. */
    it("clears the held suggestion when the next prediction is null", async () => {
        const threadSample = vi.fn()
            .mockResolvedValueOnce(suggestionSample("Run the tests"))
            .mockResolvedValueOnce(suggestionSample(null));
        const {generator, publish} = createGenerator(threadSample);

        generator.onTurnCompleted("thread", "turn-1");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("thread", "turn-2");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

        expect(publish.mock.calls).toEqual([["Run the tests"], [null]]);
    });

    /** The same suggestion twice in a row is published once. */
    it("does not republish an identical suggestion", async () => {
        const {generator, publish, threadSample} = createGenerator(vi.fn().mockResolvedValue(suggestionSample("Run the tests")));

        generator.onTurnCompleted("thread", "turn-1");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("thread", "turn-2");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalledTimes(2));
        await flush();

        expect(publish).toHaveBeenCalledTimes(1);
    });

    /** A result that finishes after invalidate() is dropped. */
    it("drops a stale result after invalidate", async () => {
        const result = deferred<SampleResult>();
        const {generator, publish, threadSample} = createGenerator(vi.fn().mockReturnValue(result.promise));

        generator.onTurnCompleted("thread", "turn");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalled());
        generator.invalidate();
        result.resolve(suggestionSample("Too late"));
        await flush();

        expect(publish).not.toHaveBeenCalled();
    });

    /** The result of an older turn loses to the one of a newer turn. */
    it("drops the result of an older turn when a newer one started", async () => {
        const first = deferred<SampleResult>();
        const second = deferred<SampleResult>();
        const {generator, publish, threadSample} = createGenerator(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));

        generator.onTurnCompleted("thread", "turn-1");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("thread", "turn-2");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalledTimes(2));
        second.resolve(suggestionSample("New"));
        first.resolve(suggestionSample("Old"));
        await flush();

        expect(publish.mock.calls).toEqual([["New"]]);
    });

    /** clear() sends the clear update only when something is held, and drops a result in flight. */
    it("clears a held suggestion once and drops a result in flight", async () => {
        const result = deferred<SampleResult>();
        const threadSample = vi.fn().mockResolvedValueOnce(suggestionSample("Run the tests")).mockReturnValueOnce(result.promise);
        const {generator, publish} = createGenerator(threadSample);

        await generator.clear();
        expect(publish).not.toHaveBeenCalled();

        generator.onTurnCompleted("thread", "turn-1");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("thread", "turn-2");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalledTimes(2));
        await generator.clear();
        await generator.clear();
        result.resolve(suggestionSample("Late"));
        await flush();

        expect(publish.mock.calls).toEqual([["Run the tests"], [null]]);
    });

    /** A rejected sample (for example a stale source turn) and a failing publish never surface. */
    it("swallows errors", async () => {
        const failing = createGenerator(vi.fn().mockRejectedValue(new Error("stale turn")));
        failing.generator.onTurnCompleted("thread", "turn");
        const publishFails = createGenerator(vi.fn().mockResolvedValue(suggestionSample("Hi")));
        publishFails.publish.mockRejectedValue(new Error("closed"));
        publishFails.generator.onTurnCompleted("thread", "turn");
        await flush();
        await vi.waitFor(() => expect(publishFails.publish).toHaveBeenCalled());
        await flush();

        expect(failing.threadSample).toHaveBeenCalled();
        expect(failing.publish).not.toHaveBeenCalled();
    });

    /** After a rebind, the next generation runs on the new app-server client. */
    it("generates on the rebound client", async () => {
        const {generator, threadSample: oldSample} = createGenerator(vi.fn());
        const threadSample = vi.fn().mockResolvedValue(suggestionSample("Go"));

        generator.rebindAppServer({threadSample} as unknown as CodexAppServerClient);
        generator.onTurnCompleted("thread", "turn");
        await vi.waitFor(() => expect(threadSample).toHaveBeenCalled());

        expect(oldSample).not.toHaveBeenCalled();
    });
});

describe("promptSuggestionsEnabled", () => {
    /** Only the value false turns the feature off. */
    it("is on unless CODEX_ACP_PROMPT_SUGGESTIONS is false", () => {
        expect(promptSuggestionsEnabled({})).toBe(true);
        expect(promptSuggestionsEnabled({CODEX_ACP_PROMPT_SUGGESTIONS: "true"})).toBe(true);
        expect(promptSuggestionsEnabled({CODEX_ACP_PROMPT_SUGGESTIONS: " False "})).toBe(false);
    });
});
