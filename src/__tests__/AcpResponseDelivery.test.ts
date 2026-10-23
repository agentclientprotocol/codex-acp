import {describe, expect, it, vi} from "vitest";
import type {AnyWireMessage, WireStream} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {AcpResponseDelivery} from "../AcpResponseDelivery";

describe("ACP response delivery", () => {
    it("waits for a complete batch write, preserving framing and request-id types", async () => {
        const delivered: Array<number | string> = [];
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const messages: AnyWireMessage[] = [];
        const stream: WireStream = {
            readable: new ReadableStream(),
            writable: new WritableStream({
                async write(message) {
                    messages.push(message);
                    await held;
                },
            }),
        };
        const delivery = new AcpResponseDelivery();
        delivery.afterWrite(0, () => { delivered.push(0); });
        delivery.afterWrite("0", () => { delivered.push("0"); });
        const observed = delivery.observe(stream);
        expect(observed.readable).toBe(stream.readable);
        const writer = observed.writable.getWriter();
        const batch: AnyWireMessage = [
            {jsonrpc: "2.0", id: 0, result: {}},
            {jsonrpc: "2.0", id: "0", error: {code: -32603, message: "Failed"}},
        ];
        const write = writer.write(batch);
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toBe(batch);
        expect(delivered).toEqual([]);
        release();
        await write;
        expect(delivered).toEqual([0, "0"]);
        expect(stream.writable.locked).toBe(false);
        await writer.close();
    });

    it("does not mistake outgoing requests or notifications for responses", async () => {
        const callback = vi.fn();
        const delivery = new AcpResponseDelivery();
        delivery.afterWrite(1, callback);
        const writer = delivery.observe({
            readable: new ReadableStream(),
            writable: new WritableStream(),
        }).writable.getWriter();
        await writer.write({jsonrpc: "2.0", id: 1, method: "client/request", params: {}});
        await writer.write({jsonrpc: "2.0", method: "session/update", params: {}});
        expect(callback).not.toHaveBeenCalled();
        await writer.write({jsonrpc: "2.0", id: 1, result: {}});
        await writer.write({jsonrpc: "2.0", id: 1, result: {}});
        expect(callback).toHaveBeenCalledTimes(1);
        await writer.close();
    });

    it("does not publish on a failed write and releases the underlying writer", async () => {
        const callback = vi.fn();
        const delivery = new AcpResponseDelivery();
        delivery.afterWrite(1, callback);
        const failure = new Error("Output closed");
        const stream: WireStream = {
            readable: new ReadableStream(),
            writable: new WritableStream({write() { throw failure; }}),
        };
        const writer = delivery.observe(stream).writable.getWriter();
        await expect(writer.write({jsonrpc: "2.0", id: 1, result: {}})).rejects.toBe(failure);
        delivery.dispose();
        expect(callback).not.toHaveBeenCalled();
        expect(stream.writable.locked).toBe(false);
    });

    it("drops callbacks on disposal and forwards aborts", async () => {
        const callback = vi.fn();
        const abort = vi.fn();
        const delivery = new AcpResponseDelivery();
        const writer = delivery.observe({
            readable: new ReadableStream(),
            writable: new WritableStream({abort}),
        }).writable.getWriter();
        delivery.afterWrite(1, callback);
        delivery.dispose();
        delivery.afterWrite(2, callback);
        await writer.write([
            {jsonrpc: "2.0", id: 1, result: {}},
            {jsonrpc: "2.0", id: 2, result: {}},
        ]);
        expect(callback).not.toHaveBeenCalled();
        await writer.abort("Disconnected");
        expect(abort).toHaveBeenCalledWith("Disconnected");
    });
});
