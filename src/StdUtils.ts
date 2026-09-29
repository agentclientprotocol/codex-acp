import {StringDecoder} from "node:string_decoder";
import {Readable, Writable} from "node:stream";
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
export function createJSONRPCReader(readable: Readable): MessageReader {
    return {
        listen(callback: DataCallback): Disposable {
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

export function createJsonStream(readable: Readable, writable: Writable){
    const input = Writable.toWeb(writable);
    const output = Readable.toWeb(readable) as ReadableStream<Uint8Array>;
    return acp.ndJsonStream(input, output);
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
