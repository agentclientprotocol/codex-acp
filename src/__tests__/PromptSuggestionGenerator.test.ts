import {describe, expect, it, vi} from "vitest";
import {PromptSuggestionGenerator, promptSuggestionsEnabled} from "../PromptSuggestionGenerator";
import {TITLE_MODEL} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {deferred} from "./acp-test-utils";

type TurnResult = {turn: {items: {type: string; text: string}[]}};

function suggestionTurn(text: string): TurnResult {
    return {turn: {items: [{type: "agentMessage", text: JSON.stringify({suggestion: text})}]}};
}

function createGenerator(runTurn: ReturnType<typeof vi.fn>) {
    const publish = vi.fn().mockResolvedValue(undefined);
    const threadStart = vi.fn().mockResolvedValue({thread: {id: "ephemeral"}});
    const client = {threadStart, runTurn} as unknown as CodexAppServerClient;
    return {generator: new PromptSuggestionGenerator(client, "/test/cwd", publish), publish, threadStart, runTurn};
}

async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("PromptSuggestionGenerator", () => {
    /** The parsed suggestion is trimmed and published; the model call runs on an ephemeral thread. */
    it("publishes the parsed suggestion", async () => {
        const {generator, publish, threadStart, runTurn} = createGenerator(vi.fn().mockResolvedValue(suggestionTurn("  Run the tests  ")));

        generator.onTurnCompleted("fix the bug", "Fixed it.");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("Run the tests"));

        expect(threadStart).toHaveBeenCalledWith({cwd: "/test/cwd", ephemeral: true});
        expect(runTurn.mock.calls[0]![0]).toMatchObject({threadId: "ephemeral", model: TITLE_MODEL});
        expect(runTurn.mock.calls[0]![0].input[0].text).toContain("fix the bug");
        expect(runTurn.mock.calls[0]![0].input[0].text).toContain("Fixed it.");
    });

    /** Each side of the exchange is cut to 4000 characters before it reaches the model. */
    it("truncates long inputs", async () => {
        const {generator, publish, runTurn} = createGenerator(vi.fn().mockResolvedValue(suggestionTurn("Go on")));

        generator.onTurnCompleted("u".repeat(10_000), "a".repeat(10_000));
        await vi.waitFor(() => expect(publish).toHaveBeenCalled());

        const text: string = runTurn.mock.calls[0]![0].input[0].text;
        expect(text.match(/u+/g)!.some(run => run.length === 4_000)).toBe(true);
        expect(text.match(/a{4000,}/g)![0]).toHaveLength(4_000);
    });

    /** A blank suggestion publishes nothing when nothing is held. */
    it("does not publish a blank suggestion when nothing was published", async () => {
        const {generator, publish, runTurn} = createGenerator(vi.fn().mockResolvedValue(suggestionTurn("   ")));

        generator.onTurnCompleted("hello", "hi");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalled());
        await flush();

        expect(publish).not.toHaveBeenCalled();
    });

    /** A blank suggestion after a published one clears it. */
    it("clears the held suggestion when the next prediction is blank", async () => {
        const runTurn = vi.fn()
            .mockResolvedValueOnce(suggestionTurn("Run the tests"))
            .mockResolvedValueOnce(suggestionTurn(""));
        const {generator, publish} = createGenerator(runTurn);

        generator.onTurnCompleted("hello", "hi");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("again", "ok");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

        expect(publish.mock.calls).toEqual([["Run the tests"], [null]]);
    });

    /** The same suggestion twice in a row is published once. */
    it("does not republish an identical suggestion", async () => {
        const {generator, publish, runTurn} = createGenerator(vi.fn().mockResolvedValue(suggestionTurn("Run the tests")));

        generator.onTurnCompleted("a", "b");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("c", "d");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));
        await flush();

        expect(publish).toHaveBeenCalledTimes(1);
    });

    /** A result that finishes after invalidate() is dropped. */
    it("drops a stale result after invalidate", async () => {
        const turn = deferred<TurnResult>();
        const {generator, publish, runTurn} = createGenerator(vi.fn().mockReturnValue(turn.promise));

        generator.onTurnCompleted("hello", "hi");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalled());
        generator.invalidate();
        turn.resolve(suggestionTurn("Too late"));
        await flush();

        expect(publish).not.toHaveBeenCalled();
    });

    /** The result of an older turn loses to the one of a newer turn. */
    it("drops the result of an older turn when a newer one started", async () => {
        const first = deferred<TurnResult>();
        const second = deferred<TurnResult>();
        const {generator, publish, runTurn} = createGenerator(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));

        generator.onTurnCompleted("one", "1");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("two", "2");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));
        second.resolve(suggestionTurn("New"));
        first.resolve(suggestionTurn("Old"));
        await flush();

        expect(publish.mock.calls).toEqual([["New"]]);
    });

    /** clear() sends the clear update only when something is held, and drops a result in flight. */
    it("clears a held suggestion once and drops a result in flight", async () => {
        const turn = deferred<TurnResult>();
        const runTurn = vi.fn().mockResolvedValueOnce(suggestionTurn("Run the tests")).mockReturnValueOnce(turn.promise);
        const {generator, publish} = createGenerator(runTurn);

        await generator.clear();
        expect(publish).not.toHaveBeenCalled();

        generator.onTurnCompleted("a", "b");
        await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
        generator.onTurnCompleted("c", "d");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));
        await generator.clear();
        await generator.clear();
        turn.resolve(suggestionTurn("Late"));
        await flush();

        expect(publish.mock.calls).toEqual([["Run the tests"], [null]]);
    });

    /** Errors of the model call, malformed output and a failing publish never surface. */
    it("swallows errors", async () => {
        const failing = createGenerator(vi.fn().mockRejectedValue(new Error("boom")));
        failing.generator.onTurnCompleted("a", "b");
        const malformed = createGenerator(vi.fn().mockResolvedValue({turn: {items: [{type: "agentMessage", text: "not json"}]}}));
        malformed.generator.onTurnCompleted("a", "b");
        const publishFails = createGenerator(vi.fn().mockResolvedValue(suggestionTurn("Hi")));
        publishFails.publish.mockRejectedValue(new Error("closed"));
        publishFails.generator.onTurnCompleted("a", "b");
        await flush();
        await vi.waitFor(() => expect(publishFails.publish).toHaveBeenCalled());
        await flush();

        expect(failing.publish).not.toHaveBeenCalled();
        expect(malformed.publish).not.toHaveBeenCalled();
    });

    /** Without a user or agent text there is nothing to predict from, so no model call is made. */
    it("skips generation when either text is blank", async () => {
        const {generator, threadStart} = createGenerator(vi.fn());

        generator.onTurnCompleted("  ", "answer");
        generator.onTurnCompleted("question", "");
        await flush();

        expect(threadStart).not.toHaveBeenCalled();
    });

    /** After a rebind, the next generation runs on the new app-server client. */
    it("generates on the rebound client", async () => {
        const {generator} = createGenerator(vi.fn());
        const runTurn = vi.fn().mockResolvedValue(suggestionTurn("Go"));
        const threadStart = vi.fn().mockResolvedValue({thread: {id: "new"}});

        generator.rebindAppServer({threadStart, runTurn} as unknown as CodexAppServerClient);
        generator.onTurnCompleted("a", "b");
        await vi.waitFor(() => expect(runTurn).toHaveBeenCalled());

        expect(threadStart).toHaveBeenCalled();
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
