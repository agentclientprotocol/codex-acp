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
            const fragments: string[] = [];
            const onData = (chunk: Buffer) => {
                const text = chunk.toString();
                let start = 0;
                for (;;) {
                    // Scan only the new chunk; large history responses may span thousands of chunks.
                    const i = text.indexOf('\n', start);
                    if (i < 0) {
                        if (start < text.length) fragments.push(text.slice(start));
                        break;
                    }
                    fragments.push(text.slice(start, i));
                    const line = fragments.join('').trim();
                    fragments.length = 0;
                    start = i + 1;
                    if (!line) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg && typeof msg === 'object' && msg.jsonrpc === undefined) {
                            msg.jsonrpc = '2.0';
                        }
                        callback(msg);
                    } catch {/* ignore malformed lines; they're still logged above */}
                }
            };
            readable.on('data', onData);
            return {
                dispose() {
                    readable.off('data', onData);
                    fragments.length = 0;
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
