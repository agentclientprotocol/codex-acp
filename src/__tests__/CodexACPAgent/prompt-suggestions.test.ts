import {afterEach, describe, expect, it, vi} from "vitest";
import {
    connectSession,
    createTurn,
    itemCompleted,
    settle,
    titleThreadId,
    turnCompleted,
    turnStarted,
    userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";
import type {ServerNotification} from "../../app-server";
import type {ThreadItem} from "../../app-server/v2";

const airCapabilities = {_meta: {jetbrains: {air: {version: 1}}}};

function agentMessage(text: string, phase: "commentary" | "final_answer" | null): ThreadItem {
    return {type: "agentMessage", id: `msg-${phase}`, text, phase, memoryCitation: null, delivery: null, questions: null};
}

function suggestionTurnCompleted(suggestion: string): ServerNotification {
    return {
        method: "turn/completed",
        params: {
            threadId: titleThreadId,
            turn: {
                ...createTurn("completed", "title-turn"),
                items: [agentMessage(JSON.stringify({suggestion, title: "A title"}), null)],
            },
        },
    };
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

    function connect(air: boolean) {
        return connectSession(protocolVersion, air
            ? {clientCapabilities: airCapabilities, v1ClientCapabilities: airCapabilities}
            : {});
    }

    /** An AIR client gets the prediction after a turn and a clear when the next prompt starts. */
    it("publishes after a turn and clears on the next prompt", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();

        await runTurn(client, protocolVersion, 0, "Fix the bug", "Fixed the bug.");
        client.emit(suggestionTurnCompleted("Run the tests"));
        await vi.waitFor(() => expect(suggestionUpdates(client)).toEqual([{suggestions: [{text: "Run the tests"}]}]));

        await runTurn(client, protocolVersion, 1, "Run the tests", "Tests pass.");
        expect(suggestionUpdates(client)).toEqual([
            {suggestions: [{text: "Run the tests"}]},
            {suggestions: []},
        ]);
    });

    /** The prediction comes from the final answer, not from a commentary message of the turn. */
    it("feeds the final answer of the main thread to the model", async () => {
        const client = await connect(true);
        closeClient = () => client.connection.close();
        const runModel = vi.spyOn(client.appServer, "runTurn");

        await runTurn(client, protocolVersion, 0, "Fix the bug", "Fixed the bug.");
        await settle();

        const inputs = runModel.mock.calls.map(([params]) => JSON.stringify(params.input));
        expect(inputs.some(input => input.includes("Fixed the bug.") && input.includes("Fix the bug") && !input.includes("Looking at it."))).toBe(true);
    });

    /** A client that is not AIR never receives a prediction. */
    it("sends nothing to a client that is not AIR", async () => {
        const client = await connect(false);
        closeClient = () => client.connection.close();
        const runModel = vi.spyOn(client.appServer, "runTurn");

        await runTurn(client, protocolVersion, 0, "Fix the bug", "Fixed the bug.");
        client.emit(suggestionTurnCompleted("Run the tests"));
        await settle();

        expect(suggestionUpdates(client)).toEqual([]);
        expect(runModel.mock.calls.some(([params]) => JSON.stringify(params.input).includes("predict"))).toBe(false);
    });
});
