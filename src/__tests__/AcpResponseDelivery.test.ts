import {describe, expect, it} from "vitest";
import type {AnyMessage} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {AcpResponseDelivery} from "../AcpResponseDelivery";

describe("ACP response delivery boundary", () => {
    it("waits for response writes and ignores notifications and null IDs", async () => {
        const delivery = new AcpResponseDelivery();
        const observed: string[] = [];
        const successful: boolean[] = [];
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const stream = delivery.observe({
            readable: new ReadableStream(),
            writable: new WritableStream<AnyMessage>({write: () => held}),
        });
        delivery.afterWrite(1, success => { observed.push("first"); successful.push(success); });
        delivery.afterWrite("two", success => { observed.push("second"); successful.push(success); });
        const writer = stream.writable.getWriter();
        const write = writer.write({jsonrpc: "2.0", id: 1, result: {}});
        await Promise.resolve();
        expect(observed).toEqual([]);
        release();
        await write;
        expect(observed).toEqual(["first"]);
        await writer.write({jsonrpc: "2.0", id: "two", error: {code: -32603, message: "Failed"}});
        expect(observed).toEqual(["first", "second"]);
        expect(successful).toEqual([true, false]);
        await writer.write({jsonrpc: "2.0", method: "session/update", params: {}});
        await writer.write({jsonrpc: "2.0", id: null, error: {code: -32600, message: "Invalid request"}});
        expect(observed).toEqual(["first", "second"]);
        await writer.close();
    });

    it("never releases snapshots on a failed write or a disposed connection", async () => {
        const delivery = new AcpResponseDelivery();
        let released = false;
        delivery.afterWrite(1, () => { released = true; });
        const stream = delivery.observe({
            readable: new ReadableStream(),
            writable: new WritableStream<AnyMessage>({write: () => { throw new Error("Write failed"); }}),
        });
        await expect(stream.writable.getWriter().write({jsonrpc: "2.0", id: 1, result: {}})).rejects.toThrow("Write failed");
        expect(released).toBe(false);
        delivery.dispose();
        delivery.afterWrite(2, () => { released = true; });
        expect(released).toBe(false);
    });
});
