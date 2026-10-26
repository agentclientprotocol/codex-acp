import {expect, it, vi} from "vitest";
import {connectSession, sessionId} from "./v2-prompt-harness";

it("waits for async transition completion and keeps the notification lane usable after rejection", async () => {
    const h = await connectSession();
    const client = h.agent["codexAcpClient"];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const first = client.enqueueSessionTransition(sessionId, async () => {
        order.push("first-start");
        await held;
        order.push("first-end");
        throw new Error("Transition failed");
    });
    const failed = expect(first).rejects.toThrow("Transition failed");
    const second = client.enqueueSessionTransition(sessionId, async () => { order.push("second"); });
    try {
        await vi.waitFor(() => expect(order).toEqual(["first-start"]));
        release();
        await failed;
        await second;
        expect(order).toEqual(["first-start", "first-end", "second"]);
    } finally { release(); h.connection.close(); }
});
