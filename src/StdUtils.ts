import {Readable, Writable} from "node:stream";
import {Emitter} from "vscode-jsonrpc/node";
import type {DataCallback, Disposable, Message, MessageReader, MessageWriter, PartialMessageInfo} from "vscode-jsonrpc/node";
import * as acp from "@agentclientprotocol/sdk";

export function withDeadline<T>(promise: Promise<T> | T, ms: number, label: string): Promise<T> {
    const thenable = Promise.resolve(promise);
    if (!Number.isFinite(ms) || ms <= 0) {
        return thenable;
    }
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        thenable.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export function writeNdjsonLine(writable: Writable, line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (!writable.writable) {
            reject(new Error("Codex app-server stdin is not writable"));
            return;
        }
        let settled = false;
        const finish = (error?: Error | null) => {
            if (settled) {
                return;
            }
            settled = true;
            writable.off("error", onError);
            writable.off("drain", onDrain);
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        const onError = (error: Error) => finish(error);
        const onDrain = () => finish();
        writable.once("error", onError);
        const ok = writable.write(line, (error) => {
            if (error) {
                finish(error);
                return;
            }
            if (ok) {
                finish();
            }
        });
        if (!ok) {
            writable.once("drain", onDrain);
        }
    });
}

//TODO ask to include proper jsonrpc field and remove
export function createJSONRPCWriter(writable: Writable): MessageWriter {
    const errorEmitter = new Emitter<[Error, Message | undefined, number | undefined]>();
    return {
        async write(msg: Message) {
            if (msg && typeof msg === 'object') {
                // remove jsonrpc for the server
                msg = {...msg};
                delete (msg as any).jsonrpc;
            }
            const line = JSON.stringify(msg) + '\n';
            try {
                await writeNdjsonLine(writable, line);
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                errorEmitter.fire([err, msg, line.length]);
                throw err;
            }
        },

        end() {
            writable.end();
        },
        onError: errorEmitter.event,
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
