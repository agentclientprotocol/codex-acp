import {describe, expect, it} from "vitest";
import type {SessionSteerRequest, SessionSteeringResponse} from "../AcpExtensions";
import {SteeringQueue} from "../SteeringQueue";

function request(text: string): SessionSteerRequest {
    return {sessionId: "session-id", prompt: [{type: "text", text}]};
}

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void} {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {promise, resolve, reject};
}

describe("SteeringQueue", () => {
    it("runs enqueued requests one at a time in arrival order", async () => {
        const order: string[] = [];
        const queue = new SteeringQueue(async (params) => {
            const text = (params.prompt[0] as {text: string}).text;
            order.push(`start:${text}`);
            await Promise.resolve();
            order.push(`end:${text}`);
            return {outcome: "injected"};
        });

        await Promise.all([
            queue.enqueue(request("a")),
            queue.enqueue(request("b")),
            queue.enqueue(request("c")),
        ]);

        // Each request fully completes before the next one starts.
        expect(order).toEqual([
            "start:a", "end:a",
            "start:b", "end:b",
            "start:c", "end:c",
        ]);
    });

    it("never overlaps two handlers", async () => {
        let active = 0;
        let maxActive = 0;
        const queue = new SteeringQueue(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            active--;
            return {outcome: "injected"};
        });

        await Promise.all(Array.from({length: 5}, (_, i) => queue.enqueue(request(`${i}`))));

        expect(maxActive).toBe(1);
    });

    it("delivers each handler result to its own caller", async () => {
        const outcomes: SessionSteeringResponse["outcome"][] = ["injected", "startedNewTurn", "injected"];
        let call = 0;
        const queue = new SteeringQueue(async () => ({outcome: outcomes[call++]!}));

        const results = await Promise.all([
            queue.enqueue(request("a")),
            queue.enqueue(request("b")),
            queue.enqueue(request("c")),
        ]);

        expect(results).toEqual([
            {outcome: "injected"},
            {outcome: "startedNewTurn"},
            {outcome: "injected"},
        ]);
    });

    it("rejects only the failing caller and keeps draining the rest", async () => {
        const seen: string[] = [];
        const queue = new SteeringQueue(async (params) => {
            const text = (params.prompt[0] as {text: string}).text;
            seen.push(text);
            if (text === "boom") {
                throw new Error("steer failed");
            }
            return {outcome: "injected"};
        });

        const first = queue.enqueue(request("ok"));
        const failing = queue.enqueue(request("boom"));
        const third = queue.enqueue(request("after"));

        await expect(first).resolves.toEqual({outcome: "injected"});
        await expect(failing).rejects.toThrow("steer failed");
        await expect(third).resolves.toEqual({outcome: "injected"});
        expect(seen).toEqual(["ok", "boom", "after"]);
    });

    it("reports isIdle before, during, and after processing", async () => {
        const gate = deferred<void>();
        const queue = new SteeringQueue(async () => {
            await gate.promise;
            return {outcome: "injected"};
        });

        expect(queue.isIdle).toBe(true);

        const inFlight = queue.enqueue(request("a"));
        expect(queue.isIdle).toBe(false);

        gate.resolve();
        await inFlight;
        expect(queue.isIdle).toBe(true);
    });
});
