import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../app-server";
import {logger} from "../Logger";
import {PendingNotificationBuffer} from "../subagents/PendingNotificationBuffer";

function delta(itemId: string, text: string): ServerNotification {
    return {method: "item/agentMessage/delta", params: {threadId: "child", turnId: "t", itemId, delta: text}};
}

describe("PendingNotificationBuffer", () => {
    it("merges adjacent deltas of the same item and keeps the order", () => {
        const buffer = new PendingNotificationBuffer("child");
        buffer.push(delta("a", "Hel"));
        buffer.push(delta("a", "lo"));
        buffer.push(delta("b", "!"));
        buffer.push(delta("a", "?"));

        expect(buffer.take().map(notification => notification.params)).toEqual([
            {threadId: "child", turnId: "t", itemId: "a", delta: "Hello"},
            {threadId: "child", turnId: "t", itemId: "b", delta: "!"},
            {threadId: "child", turnId: "t", itemId: "a", delta: "?"},
        ]);
    });

    it("does not change the notification objects that the caller pushed", () => {
        const buffer = new PendingNotificationBuffer("child");
        const first = delta("a", "Hel");
        const second = delta("a", "lo");
        buffer.push(first);
        buffer.push(second);

        expect(first).toEqual(delta("a", "Hel"));
        expect(second).toEqual(delta("a", "lo"));
        expect((buffer.take()[0]!.params as {delta: string}).delta).toBe("Hello");
    });

    it("keeps thousands of deltas without a loss", () => {
        const buffer = new PendingNotificationBuffer("child");
        for (let index = 0; index < 5000; index++) buffer.push(delta("a", "x"));

        const taken = buffer.take();
        expect(taken).toHaveLength(1);
        expect((taken[0]!.params as {delta: string}).delta).toHaveLength(5000);
    });

    it("counts the escaped size of a merged delta against the byte cap", () => {
        const log = vi.spyOn(logger, "log").mockImplementation(() => {});
        const first = delta("a", "x");
        const maxBytes = Buffer.byteLength(JSON.stringify(first), "utf8") + 10;
        const buffer = new PendingNotificationBuffer("child", maxBytes);
        buffer.push(first);
        // Each quote and each newline is 1 byte of text, but 2 bytes in JSON.
        buffer.push(delta("a", "\"\n\"\n\"\n"));
        buffer.push(delta("a", "12345"));

        const taken = buffer.take();
        expect(taken.reduce((bytes, notification) => bytes + Buffer.byteLength(JSON.stringify(notification), "utf8"), 0))
            .toBeLessThanOrEqual(maxBytes);
        expect((taken[0]!.params as {delta: string}).delta).toBe("x12345");
        log.mockRestore();
    });

    it("drops and logs only when the byte cap is hit", () => {
        const log = vi.spyOn(logger, "log").mockImplementation(() => {});
        const buffer = new PendingNotificationBuffer("child", 300);
        buffer.push(delta("a", "x".repeat(100)));
        buffer.push(delta("a", "y".repeat(300)));

        expect(buffer.size).toBe(1);
        expect(log).toHaveBeenCalledTimes(1);
        log.mockRestore();
    });
});
