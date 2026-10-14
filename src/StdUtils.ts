import {StringDecoder} from "node:string_decoder";
import {finished, Readable, Writable} from "node:stream";
import {Emitter} from "vscode-jsonrpc/node";
import type {DataCallback, Disposable, Message, MessageReader, MessageWriter, PartialMessageInfo} from "vscode-jsonrpc/node";
import * as acp from "@agentclientprotocol/sdk";
import {logger} from "./Logger";

//TODO ask to include proper jsonrpc field and remove
export function createJSONRPCWriter(writable: Writable): MessageWriter {
    return {
        async write(msg: Message) {
            try {
                if (msg && typeof msg === 'object') {
                    // remove jsonrpc for the server
                    msg = {...msg};
                    delete (msg as any).jsonrpc;
                }
                writable.write(JSON.stringify(msg) + '\n');
            } catch {/* ignore */
            }
        },

        end() {
            writable.end();
        },
        onError: new Emitter<[Error, Message | undefined, number | undefined]>().event,
        onClose: new Emitter<void>().event,

        dispose() { }
    };
}

//TODO ask to include proper jsonrpc field and remove
export function createJSONRPCReader(readable: Readable): MessageReader & {deliver?: (message: Message) => void} {
    let listener: DataCallback | null = null;
    return {
        /** Hands `message` to the connection after the messages read so far. */
        deliver(message: Message) {
            listener?.(message);
        },
        listen(callback: DataCallback): Disposable {
            listener = callback;
            const onLine = (text: string) => {
                const line = text.trim();
                if (!line) return;
                let msg: unknown;
                try {
                    msg = JSON.parse(line);
                } catch (error) {
                    // A lost line can be a lost response, and its request then waits forever.
                    logger.error(`Dropped a Codex app-server line that is not JSON (${line.length} chars)`, error);
                    return;
                }
                if (msg && typeof msg === 'object' && (msg as {jsonrpc?: unknown}).jsonrpc === undefined) {
                    (msg as {jsonrpc: string}).jsonrpc = '2.0';
                }
                callback(msg as Message);
            };
            const lines = new LineSplitter(onLine);
            const onData = (chunk: Buffer) => lines.push(chunk);
            const onEnd = () => lines.end();
            readable.on('data', onData);
            readable.on('end', onEnd);
            return {
                dispose() {
                    readable.off('data', onData);
                    readable.off('end', onEnd);
                }
            }
        },
        onError: new Emitter<Error>().event,
        onClose: new Emitter<void>().event,
        onPartialMessage: new Emitter<PartialMessageInfo>().event,
        dispose() {}
    }
}

export function createJsonStream(readable: Readable, writable: Writable): acp.Stream {
    const writeLine = createLineWriter(writable);
    // The SDK writes only its parse error replies to this stream.
    const errorReplies = new WritableStream<Uint8Array>({write: chunk => writeLine(chunk)});
    const input = Readable.toWeb(readable) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(errorReplies, input);
    // The SDK encodes each message with TextEncoder and writes it through a web stream adapter.
    // A string write to the Node stream encodes it in native code, and is faster for a large history.
    const messages = new WritableStream<acp.AnyMessage>({
        write: message => writeLine(JSON.stringify(message) + "\n"),
    });
    return {readable: stream.readable, writable: messages};
}

/**
 * Returns a function that writes one line to `writable`, with the same contract as `Writable.toWeb`.
 *
 * The promise waits for `drain` when the stream buffer is full, so a large history keeps the backpressure.
 * After an error, an end or a close of the stream, each write rejects, so the ACP connection closes.
 */
export function createLineWriter(writable: Writable): (line: string | Uint8Array) => Promise<void> {
    let failure: Error | undefined;
    const waiting = new Set<{resolve: () => void; reject: (error: Error) => void}>();
    const stopWatching = finished(writable, error => {
        stopWatching();
        // `finished` no longer listens, so a later error must not become an uncaught exception.
        writable.on("error", () => {});
        writable.off("drain", onDrain);
        failure = error ?? new Error("The output stream ended");
        for (const waiter of waiting) waiter.reject(failure);
        waiting.clear();
    });
    const onDrain = () => {
        for (const waiter of waiting) waiter.resolve();
        waiting.clear();
    };
    writable.on("drain", onDrain);
    return line => {
        if (failure !== undefined) return Promise.reject(failure);
        if (writable.write(line)) return Promise.resolve();
        return new Promise((resolve, reject) => waiting.add({resolve, reject}));
    };
}

/**
 * Splits a byte stream into lines at `\n` only.
 *
 * JSON allows U+2028 and U+2029 unescaped in a string, and Codex writes them so. `readline` also ends a line at
 * these characters, so it split a message and lost it. The splitter decodes UTF-8 across chunks and searches only
 * the new text for a line break, so a long line costs linear time.
 */
class LineSplitter {
    private readonly decoder = new StringDecoder("utf8");
    /** The parts of the line whose end has not arrived yet. */
    private parts: string[] = [];

    constructor(private readonly onLine: (line: string) => void) {}

    push(chunk: Buffer): void {
        const text = this.decoder.write(chunk);
        let start = 0;
        for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
            this.parts.push(text.slice(start, end));
            const line = this.parts.join("");
            this.parts = [];
            start = end + 1;
            this.onLine(line);
        }
        if (start < text.length) this.parts.push(text.slice(start));
    }

    end(): void {
        const rest = this.decoder.end();
        if (rest.length > 0) this.parts.push(rest);
        if (this.parts.length > 0) {
            const line = this.parts.join("");
            this.parts = [];
            this.onLine(line);
        }
    }
}

/**
 * The value of `promise`, or `"pending"` when it does not settle within `ms`.
 * A rejection before the timeout rejects. A later rejection is ignored.
 */
export async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"pending">(resolve => {
        timer = setTimeout(() => resolve("pending"), Math.max(0, ms));
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
