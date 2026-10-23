import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {describe, expect, it} from "vitest";
import {AcpV2ForegroundState} from "../AcpV2ForegroundState";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return {promise, resolve};
}

function fixture() {
    const updates: acpV2.StateUpdate[] = [];
    const foreground = new AcpV2ForegroundState(async state => { updates.push(state); });
    return {foreground, updates};
}

describe("ACP v2 aggregate foreground state", () => {
    it("invalidates old interaction waits when observability is lost", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        const wait = deferred();
        const action = foreground.withUserAction(undefined, () => wait.promise);
        await foreground.snapshot();
        await foreground.update({state: "unknown"});
        wait.resolve();
        await action;
        await foreground.snapshot();
        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-unknown-late-answer.json");
    });

    it("keeps running while another tool can progress, then tracks which waits still block", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        await foreground.startItem("first");
        await foreground.startItem("second");
        const first = deferred();
        const second = deferred();
        const firstAction = foreground.withUserAction("first", () => first.promise);
        await foreground.snapshot();
        const secondAction = foreground.withUserAction("second", () => second.promise);
        await foreground.snapshot();
        first.resolve();
        await firstAction;
        await foreground.completeItem("first");
        second.resolve();
        await secondAction;
        await foreground.completeItem("second");
        await foreground.update({state: "idle", stopReason: "end_turn"});

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-parallel-tools.json");
    });

    it("does not resume after one of several uncorrelated waits is answered", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        const first = deferred();
        const second = deferred();
        const firstAction = foreground.withUserAction(undefined, () => first.promise);
        const secondAction = foreground.withUserAction(undefined, () => second.promise);
        await foreground.snapshot();
        first.resolve();
        await firstAction;
        await foreground.snapshot();
        second.resolve();
        await secondAction;

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-overlapping-waits.json");
    });

    it("reports resumed progress even while an interaction remains pending", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        const waiting = deferred();
        const action = foreground.withUserAction(undefined, () => waiting.promise);
        await foreground.snapshot();
        await foreground.startItem("model-output");
        await foreground.completeItem("model-output");
        waiting.resolve();
        await action;
        await foreground.update({state: "idle", stopReason: "end_turn"});
        await foreground.startItem("late-output");
        await foreground.snapshot();

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-resumed-progress.json");
    });

    it("does not let a previous turn's late answer change a new turn", async () => {
        const {foreground, updates} = fixture();
        const oldWait = deferred();
        const oldAction = foreground.withUserAction(undefined, () => oldWait.promise);
        await foreground.snapshot();
        await foreground.update({state: "idle", stopReason: "cancelled"});
        await foreground.start();
        const newWait = deferred();
        const newAction = foreground.withUserAction(undefined, () => newWait.promise);
        await foreground.snapshot();
        oldWait.resolve();
        await oldAction;
        await foreground.snapshot();
        newWait.resolve();
        await newAction;
        await foreground.update({state: "idle", stopReason: "end_turn"});

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-late-answer.json");
    });

    it("does not resume when a pending interaction is withdrawn", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        const waiting = deferred();
        const controller = new AbortController();
        const action = foreground.withUserAction(undefined, () => waiting.promise, controller.signal);
        await foreground.snapshot();
        controller.abort();
        waiting.resolve();
        await action;
        await foreground.update({state: "idle", stopReason: "cancelled"});

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-withdrawn-wait.json");
    });

    it("does not report a wait whose request was already cancelled", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        const controller = new AbortController();
        controller.abort();
        await foreground.withUserAction(undefined, async () => {}, controller.signal);
        expect(updates).toEqual([{state: "running"}]);
    });

    it("sends snapshots without replaying completion usage or metadata", async () => {
        const {foreground, updates} = fixture();
        await foreground.start();
        await foreground.update({
            state: "idle",
            stopReason: "end_turn",
            usage: {totalTokens: 3, inputTokens: 1, outputTokens: 2},
            _meta: {quota: {total: 3}},
        });
        await foreground.snapshot();
        await foreground.snapshot();

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-idle-snapshot.json");
    });

    it("orders snapshots and later transitions behind a backpressured send", async () => {
        const gate = deferred();
        const updates: acpV2.StateUpdate[] = [];
        const foreground = new AcpV2ForegroundState(async state => {
            if (state.state === "running") await gate.promise;
            updates.push(state);
        });
        const started = foreground.start();
        const snapshot = foreground.snapshot();
        const stopped = foreground.update({state: "idle", stopReason: "cancelled"});
        gate.resolve();
        await Promise.all([started, snapshot, stopped]);

        await expect(JSON.stringify(updates, null, 2)).toMatchFileSnapshot("data/foreground-v2-send-order.json");
    });
});
