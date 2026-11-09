import {PassThrough, Writable} from "node:stream";
import {describe, expect, it, vi} from "vitest";
import {createJsonStream, createJSONRPCReader, createLineWriter, settledWithin} from "../StdUtils";

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

    it("keeps a message whose string holds U+2028 or U+2029 in one line", async () => {
        // JSON allows these characters unescaped. readline ended a line at them and lost the message.
        const messages = await read([Buffer.from(JSON.stringify({id: 1, result: {text: "a\u2028b\u2029c"}}) + "\n")]);

        expect(messages).toEqual([{jsonrpc: "2.0", id: 1, result: {text: "a\u2028b\u2029c"}}]);
    });

    it("reads a last line without a line break at the end of the stream", async () => {
        const messages = await read([Buffer.from('{"id":1,"result":{}}\n{"id":2,"result":{}}')]);

        expect(messages).toEqual([
            {jsonrpc: "2.0", id: 1, result: {}},
            {jsonrpc: "2.0", id: 2, result: {}},
        ]);
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

/** A stream that keeps each write callback until the test calls `release`, and then calls back at once. */
function slowWritable(highWaterMark: number) {
    const written: string[] = [];
    let held: ((error?: Error | null) => void) | undefined;
    let released = false;
    const writable = new Writable({
        highWaterMark,
        write(chunk: Buffer, _encoding, callback) {
            written.push(chunk.toString("utf8"));
            if (released) callback(); else held = callback;
        },
    });
    const release = (error?: Error) => {
        released = true;
        held?.(error);
    };
    return {writable, written, release};
}

function settled(promise: Promise<unknown>): Promise<string> {
    return Promise.race([
        promise.then(() => "resolved", (error: Error) => `rejected: ${error.message}`),
        new Promise<string>(resolve => setTimeout(() => resolve("pending"), 20)),
    ]);
}

describe("createLineWriter", () => {
    it("waits for drain when the stream buffer is full", async () => {
        const {writable, written, release} = slowWritable(16);
        const writeLine = createLineWriter(writable);

        expect(await settled(writeLine("short\n"))).toBe("resolved");
        const large = writeLine("x".repeat(1024) + "\n");
        expect(await settled(large)).toBe("pending");

        release();
        expect(await settled(large)).toBe("resolved");
        expect(written).toEqual(["short\n", "x".repeat(1024) + "\n"]);
    });

    it("rejects the waiting write and each later write when the stream fails", async () => {
        const {writable, release} = slowWritable(16);
        const writeLine = createLineWriter(writable);
        const waiting = writeLine("x".repeat(1024) + "\n");

        release(Object.assign(new Error("write EPIPE"), {code: "EPIPE"}));

        expect(await settled(waiting)).toBe("rejected: write EPIPE");
        expect(await settled(writeLine("next\n"))).toBe("rejected: write EPIPE");
        // A later error of the stream is not an uncaught exception.
        writable.emit("error", new Error("write EPIPE"));
    });

    it("rejects a write after the stream ended", async () => {
        const writable = new PassThrough();
        writable.resume();
        const writeLine = createLineWriter(writable);
        writable.end();
        await new Promise(resolve => writable.on("finish", resolve));
        await new Promise(resolve => setImmediate(resolve));

        expect(await settled(writeLine("late\n"))).toBe("rejected: The output stream ended");
    });
});

describe("createJsonStream", () => {
    it("writes each message as one JSON line with the bytes of JSON.stringify", async () => {
        const output = new PassThrough();
        const chunks: Buffer[] = [];
        output.on("data", (chunk: Buffer) => chunks.push(chunk));
        const stream = createJsonStream(new PassThrough(), output);
        const message = {jsonrpc: "2.0" as const, method: "session/update", params: {text: "я \u2028 \ud83d\ude00 \ud800"}};

        const writer = stream.writable.getWriter();
        await writer.write(message);
        await writer.write({jsonrpc: "2.0", id: 1, result: {}});

        expect(Buffer.concat(chunks)).toEqual(Buffer.from(
            new TextEncoder().encode(JSON.stringify(message) + "\n" + JSON.stringify({jsonrpc: "2.0", id: 1, result: {}}) + "\n"),
        ));
    });

    it("rejects a message write after the output stream failed", async () => {
        const {writable, release} = slowWritable(16);
        const stream = createJsonStream(new PassThrough(), writable);
        const writer = stream.writable.getWriter();
        const waiting = writer.write({jsonrpc: "2.0", method: "m", params: {text: "x".repeat(1024)}});
        expect(await settled(waiting)).toBe("pending");

        release(new Error("write EPIPE"));

        expect(await settled(waiting)).toBe("rejected: write EPIPE");
        expect(await settled(writer.write({jsonrpc: "2.0", id: 1, result: {}}))).toBe("rejected: write EPIPE");
    });
});

describe("settledWithin", () => {
    it("returns the value, or pending at the timeout, and rejects only before the timeout", async () => {
        vi.useFakeTimers();
        try {
            await expect(settledWithin(Promise.resolve("done"), 100)).resolves.toBe("done");
            await expect(settledWithin(Promise.reject(new Error("early")), 100)).rejects.toThrow("early");

            let rejectLate!: (error: Error) => void;
            const late = settledWithin(new Promise((_, reject) => { rejectLate = reject; }), 100);
            await vi.advanceTimersByTimeAsync(100);
            rejectLate(new Error("late"));
            await expect(late).resolves.toBe("pending");
        } finally {
            vi.useRealTimers();
        }
    });
});
