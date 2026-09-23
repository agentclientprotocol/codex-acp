import {createInterface} from "node:readline";
import {Readable, Writable} from "node:stream";
import {Emitter} from "vscode-jsonrpc/node";
import type {DataCallback, Disposable, Message, MessageReader, MessageWriter, PartialMessageInfo} from "vscode-jsonrpc/node";
import * as acp from "@agentclientprotocol/sdk";

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
            // readline decodes UTF-8 across chunk boundaries and searches only
            // the new chunk for a line break, so a long line costs linear time.
            const lines = createInterface({input: readable, crlfDelay: Infinity});
            lines.on('line', (text: string) => {
                const line = text.trim();
                if (!line) return;
                try {
                    const msg = JSON.parse(line);
                    if (msg && typeof msg === 'object' && msg.jsonrpc === undefined) {
                        msg.jsonrpc = '2.0';
                    }
                    callback(msg);
                } catch {/* ignore malformed lines; they're still logged above */}
            });
            return {
                dispose() {
                    lines.close();
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
