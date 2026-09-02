import {describe, expect, it} from "vitest";
import type {UpdateSessionEvent} from "../ACPSessionConnection";
import {mergeHistoryUpdates} from "../CodexAcpServer";

describe("mergeHistoryUpdates", () => {
    it("uses the earliest content or exact-key match", () => {
        const earlierContentMatch = message("fallback-id", "same content", "fallback-content");
        const laterExactMatch = message("target-id", "same content", "fallback-exact");
        const target = message("target-id", "same content", "thread");

        expect(mergeHistoryUpdates(
            [earlierContentMatch, laterExactMatch],
            [target],
        )).toEqual([target]);
    });

    it("does not revisit matches before the advancing fallback cursor", () => {
        const targetA = message("message-a", "alpha", "thread-a");
        const between = thought("thought-between", "keep between matches");
        const targetB = message("message-b", "beta", "thread-b");

        expect(mergeHistoryUpdates(
            [
                message("message-a", "alpha", "fallback-a"),
                between,
                message("message-b", "beta", "fallback-b"),
                message("message-a", "alpha", "fallback-a-late"),
            ],
            [targetA, targetB],
        )).toEqual([targetA, between, targetB]);
    });
});

function message(messageId: string, text: string, source: string): UpdateSessionEvent {
    return {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: {type: "text", text},
        _meta: {source},
    };
}

function thought(messageId: string, text: string): UpdateSessionEvent {
    return {
        sessionUpdate: "agent_thought_chunk",
        messageId,
        content: {type: "text", text},
    };
}
