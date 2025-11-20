import {Readable, Writable} from "node:stream";
import {Disposable} from "vscode-jsonrpc";
import {PartialMessageInfo} from "vscode-jsonrpc/lib/common/messageReader";
import {Emitter, Message, DataCallback, MessageReader, MessageWriter} from "vscode-jsonrpc/node";
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
            let buf = '';
            const onData = (chunk: Buffer) => {
                buf += chunk.toString();
                for (;;) {
                    const i = buf.indexOf('\n');
                    if (i < 0) break;
                    const line = buf.slice(0, i).trim();
                    buf = buf.slice(i + 1);
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