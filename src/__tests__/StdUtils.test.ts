import {PassThrough} from "node:stream";
import {describe, expect, it} from "vitest";
import {createJSONRPCReader} from "../StdUtils";

function read(chunks: Buffer[]): Promise<unknown[]> {
    const stream = new PassThrough();
    const messages: unknown[] = [];
    createJSONRPCReader(stream).listen((message) => messages.push(message));
    return new Promise((resolve) => {
        stream.on("end", () => setImmediate(() => resolve(messages)));
        for (const chunk of chunks) stream.write(chunk);
        stream.end();
    });
}

describe("createJSONRPCReader", () => {
    it("keeps a character whose UTF-8 bytes span two chunks", async () => {
        const bytes = Buffer.from(JSON.stringify({method: "m", params: {text: "я"}}) + "\n");
        const split = bytes.indexOf(Buffer.from("я")) + 1;

        const messages = await read([bytes.subarray(0, split), bytes.subarray(split)]);

        expect(messages).toEqual([{jsonrpc: "2.0", method: "m", params: {text: "я"}}]);
    });

    it("reads several messages of one chunk and skips blank and malformed lines", async () => {
        const messages = await read([Buffer.from('{"id":1,"result":{}}\n\n{bad\n{"id":2,"result":{}}\r\n')]);

        expect(messages).toEqual([
            {jsonrpc: "2.0", id: 1, result: {}},
            {jsonrpc: "2.0", id: 2, result: {}},
        ]);
    });

    it("reads a 20 MB line in linear time", async () => {
        const text = "x".repeat(20 * 1024 * 1024);
        const bytes = Buffer.from(JSON.stringify({method: "m", params: {text}}) + "\n");
        const chunks: Buffer[] = [];
        for (let start = 0; start < bytes.length; start += 64 * 1024) {
            chunks.push(bytes.subarray(start, start + 64 * 1024));
        }

        const started = performance.now();
        const messages = await read(chunks);

        expect((messages[0] as {params: {text: string}}).params.text.length).toBe(text.length);
        // The old reader rescanned the whole partial line on each chunk and
        // took about 6 s here. The bound leaves room for JSON.parse and a slow CI.
        expect(performance.now() - started).toBeLessThan(3000);
    });
});
