import {afterEach, describe, expect, it, vi} from "vitest";
import {
    connectSession, createTurn, dump, itemCompleted, itemStarted, settle, stateUpdates,
    turnCompleted, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";

describe.each([1, 2] as const)("non-steerable command completion over ACP v%s", version => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    it.each(["compact", "review"])("holds the next prompt until /%s ends, not just its item", async command => {
        client = await connectSession(version);
        const start = vi.fn(async () => ({turn: createTurn("inProgress", "command-turn"), reviewThreadId: "thread-1"}));
        client.setCodexResponse(command === "compact" ? "thread/compact/start" : "review/start", start);
        const steer = vi.fn(async () => { throw new Error("This turn cannot accept steering"); });
        client.setCodexResponse("turn/steer", steer);
        const commandResponse = client.sendPrompt([{type: "text", text: `/${command}`}]);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        // V2 accepts the command early, but its foreground work must remain running.
        if (version === 2) await commandResponse;
        let finished = false;
        const commandFinished = client.promptRunFinished().then(() => { finished = true; });
        const item = command === "compact"
            ? {type: "contextCompaction" as const, id: "compaction-item"}
            : {type: "exitedReviewMode" as const, id: "review-item", review: "Review result"};
        client.emit(turnStarted("command-turn"));
        client.emit(itemStarted(item, "command-turn"));
        client.emit(itemCompleted(item, "command-turn"));
        await settle();
        expect(finished).toBe(false);
        expect(stateUpdates(client.transcript).some(update => update.state === "idle")).toBe(false);

        const next = client.sendPrompt([{type: "text", text: "Next prompt"}]);
        await settle();
        expect(client.turnStartParams).toEqual([]);
        expect(steer).not.toHaveBeenCalled();

        client.emit(turnCompleted("command-turn"));
        await commandFinished;
        await commandResponse;
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const messageId = client.turnStartParams[0]!["clientUserMessageId"];
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(typeof messageId === "string" ? messageId : null, "Next prompt")));
        if (version === 2) await next;
        client.emit(turnCompleted());
        await next;
        await client.promptRunFinished(1);
        await settle();

        const timeline = client.transcript.flatMap(entry => {
            if ("codexNotification" in entry) return [entry.codexNotification];
            if ("codexRequest" in entry) return [entry.codexRequest];
            if ("promptResponse" in entry) return ["prompt_response"];
            if ("sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "state_update") {
                return [`state:${entry.sessionUpdate.state}`];
            }
            return [];
        });
        await expect(dump(timeline)).toMatchFileSnapshot(`data/${command}-command-v${version}-ordering.json`);
    });
});
