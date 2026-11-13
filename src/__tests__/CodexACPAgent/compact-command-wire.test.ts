import {afterEach, describe, expect, it, vi} from "vitest";
import {
    connectSession, dump, itemCompleted, itemStarted, settle, stateUpdates,
    turnCompleted, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";

describe.each([1, 2] as const)("/compact completion over ACP v%s", version => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    it("holds the next prompt until the compact turn ends, not just its item", async () => {
        client = await connectSession(version);
        const start = vi.fn(async () => ({}));
        client.setCodexResponse("thread/compact/start", start);
        const compact = client.sendPrompt([{type: "text", text: "/compact"}]);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        // V2 accepts the command early, but its foreground work must remain running.
        if (version === 2) await compact;
        let finished = false;
        const compactFinished = client.promptRunFinished().then(() => { finished = true; });
        const item = {type: "contextCompaction" as const, id: "compaction-item"};
        client.emit(turnStarted("compact-turn"));
        client.emit(itemStarted(item, "compact-turn"));
        client.emit(itemCompleted(item, "compact-turn"));
        await settle();
        expect(finished).toBe(false);
        expect(stateUpdates(client.transcript).some(update => update.state === "idle")).toBe(false);

        const next = client.sendPrompt([{type: "text", text: "Next prompt"}]);
        await settle();
        expect(client.turnStartParams).toEqual([]);

        client.emit(turnCompleted("compact-turn"));
        await compactFinished;
        await compact;
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
        await expect(dump(timeline)).toMatchFileSnapshot(`data/compact-command-v${version}-ordering.json`);
    });
});
