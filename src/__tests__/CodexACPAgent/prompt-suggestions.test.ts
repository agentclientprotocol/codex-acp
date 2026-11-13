import {afterEach, describe, expect, it, vi} from "vitest";
import {
    connectSession,
    itemCompleted,
    sessionId,
    settle,
    turnCompleted,
    turnFinished,
    turnStarted,
    userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";
import type {ThreadItem} from "../../app-server/v2";

const airCapabilities = {_meta: {jetbrains: {air: {version: 1}}}};

function agentMessage(text: string, phase: "commentary" | "final_answer" | null): ThreadItem {
    return {type: "agentMessage", id: `msg-${phase}`, text, phase, memoryCitation: null, delivery: null, questions: null};
}

/** The `promptSuggestions` values of the session info updates the client received, in order. */
function suggestionUpdates(client: PromptSession): unknown[] {
    return client.scopedUpdates.flatMap(({update}) => {
        const meta = (update as {_meta?: Record<string, unknown>})._meta;
        return update.sessionUpdate === "session_info_update" && meta?.["promptSuggestions"] !== undefined
            ? [meta["promptSuggestions"]]
            : [];
    });
}

/** Runs turn number `index` (from 0) to completion; its id is `turn-${index + 1}`. */
async function runTurn(client: PromptSession, protocolVersion: 1 | 2, index: number, text: string, answer: string) {
    const turnId = `turn-${index + 1}`;
    const response = client.sendPrompt([{type: "text", text}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(index + 1));
    const params = client.turnStartParams[index]!;
    client.emit(turnStarted(turnId));
    if (protocolVersion === 2) {
        client.emit(itemCompleted(userMessageItem(params["clientUserMessageId"] as string, text), turnId));
    }
    client.emit(itemCompleted(agentMessage("Looking at it.", "commentary"), turnId));
    client.emit(itemCompleted(agentMessage(answer, "final_answer"), turnId));
    client.emit(turnCompleted(turnId));
    await response;
    await client.promptRunFinished(index);
}

describe.each([1, 2] as const)("predicted follow-up prompt over ACP v%i", (protocolVersion) => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    let sampleParams: Array<Record<string, unknown>> = [];

    function connect(air: boolean) {
        sampleParams = [];
        return connectSession(protocolVersion, {
            ...(air ? {clientCapabilities: airCapabilities, v1ClientCapabilities: airCapabilities} : {}),
            codexResponses: {
                "thread/sample": async params => {
                    sampleParams.push(params as Record<string, unknown>);
                    return {
                        sourceTurnId: (params as {expectedTurnId: string}).expectedTurnId,
                        responseId: "r",
                        text: JSON.stringify({suggestion: "Run the tests"}),
                        inputTokens: null,
                        cachedInputTokens: null,
                        outputTokens: null,
                    };
                },
            },
        });
    }

    /** An AIR client gets the prediction after a turn and a clear when the next prompt starts. */
    it("publishes after a turn and clears on the next prompt", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();

        await runTurn(client, protocolVersion, 0, "Fix the bug", "Fixed the bug.");
        await vi.waitFor(() => expect(suggestionUpdates(client)).toEqual([{suggestions: [{text: "Run the tests"}]}]));

        await runTurn(client, protocolVersion, 1, "Run the tests", "Tests pass.");
        await vi.waitFor(() => expect(suggestionUpdates(client)).toHaveLength(3));
        expect(suggestionUpdates(client).slice(0, 2)).toEqual([
            {suggestions: [{text: "Run the tests"}]},
            {suggestions: []},
        ]);
    });

    /** The prediction samples the session's own thread, anchored at the turn that just completed. */
    it("samples the session thread with the completed turn id", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();

        await runTurn(client, protocolVersion, 0, "Fix the bug", "Fixed the bug.");
        await vi.waitFor(() => expect(sampleParams).toHaveLength(1));

        expect(sampleParams[0]).toMatchObject({threadId: sessionId, expectedTurnId: "turn-1"});
    });

    /** A client that is not AIR never receives a prediction and no sample is requested. */
    it("sends nothing to a client that is not AIR", async () => {
        const client = await connect(false);
        closeClient = () => client.connection.close();

        await runTurn(client, protocolVersion, 0, "Fix the bug", "Fixed the bug.");
        await settle();

        expect(suggestionUpdates(client)).toEqual([]);
        expect(sampleParams).toEqual([]);
    });

    /** In plan mode no prediction is requested or published. */
    it("does not predict in plan mode", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();
        await client.request("session/set_config_option", {
            sessionId, configId: "collaboration_mode", value: "plan",
            ...(protocolVersion === 2 ? {type: "id"} : {}),
        });

        await runTurn(client, protocolVersion, 0, "Plan the fix", "Here is the plan.");
        await settle();

        expect(suggestionUpdates(client)).toEqual([]);
        expect(sampleParams).toEqual([]);
    });

    /** A turn Codex reports as interrupted requests no sample and publishes no prediction. */
    it("does not predict after an interrupted turn", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Fix the bug"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted("turn-1"));
        client.emit(turnFinished("interrupted", "turn-1"));
        await response.catch(() => undefined);
        await settle();

        expect(suggestionUpdates(client)).toEqual([]);
        expect(sampleParams).toEqual([]);
    });

    /** A turn Codex reports as failed requests no sample and publishes no prediction. */
    it("does not predict after a failed turn", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();

        const response = client.sendPrompt([{type: "text", text: "Fix the bug"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted("turn-1"));
        client.emit(turnFinished("failed", "turn-1"));
        await response.catch(() => undefined);
        await settle();

        expect(suggestionUpdates(client)).toEqual([]);
        expect(sampleParams).toEqual([]);
    });
});
