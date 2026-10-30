import type {AnyMessage, JsonRpcId, Stream} from "@agentclientprotocol/sdk/experimental/v2/unstable";

/** Observe completed response writes without changing SDK framing. */
export class AcpResponseDelivery {
    private readonly callbacks = new Map<JsonRpcId, () => void>();
    private disposed = false;

    afterWrite(requestId: JsonRpcId, callback: () => void): void {
        if (!this.disposed) this.callbacks.set(requestId, callback);
    }

    observe(stream: Stream): Stream {
        return {
            readable: stream.readable,
            writable: new WritableStream<AnyMessage>({
                write: async message => {
                    const writer = stream.writable.getWriter();
                    try { await writer.write(message); }
                    finally { writer.releaseLock(); }
                    if ("method" in message || message.id === null) return;
                    const callback = this.callbacks.get(message.id);
                    this.callbacks.delete(message.id);
                    callback?.();
                },
                close: async () => {
                    const writer = stream.writable.getWriter();
                    try { await writer.close(); }
                    finally { this.dispose(); writer.releaseLock(); }
                },
                abort: async reason => {
                    const writer = stream.writable.getWriter();
                    try { await writer.abort(reason); }
                    finally { this.dispose(); writer.releaseLock(); }
                },
            }),
        };
    }

    dispose(): void { this.disposed = true; this.callbacks.clear(); }
}
