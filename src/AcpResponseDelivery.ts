import type {AnyWireMessage, JsonRpcId, WireStream} from "@agentclientprotocol/sdk/experimental/v2/unstable";

/** Observes completed wire writes without changing SDK messages or batch framing. */
export class AcpResponseDelivery {
    private readonly callbacks = new Map<JsonRpcId, () => void>();
    private disposed = false;

    afterWrite(requestId: JsonRpcId, callback: () => void): void {
        if (!this.disposed) this.callbacks.set(requestId, callback);
    }

    observe(stream: WireStream): WireStream {
        return {
            readable: stream.readable,
            writable: new WritableStream<AnyWireMessage>({
                write: async message => {
                    const writer = stream.writable.getWriter();
                    try {
                        await writer.write(message);
                    } finally {
                        writer.releaseLock();
                    }
                    for (const entry of Array.isArray(message) ? message : [message]) {
                        if ("method" in entry || entry.id === null) continue;
                        const callback = this.callbacks.get(entry.id);
                        this.callbacks.delete(entry.id);
                        callback?.();
                    }
                },
                close: async () => {
                    const writer = stream.writable.getWriter();
                    try {
                        await writer.close();
                    } finally {
                        this.dispose();
                        writer.releaseLock();
                    }
                },
                abort: async reason => {
                    const writer = stream.writable.getWriter();
                    try {
                        await writer.abort(reason);
                    } finally {
                        this.dispose();
                        writer.releaseLock();
                    }
                },
            }),
        };
    }

    dispose(): void {
        this.disposed = true;
        this.callbacks.clear();
    }
}
