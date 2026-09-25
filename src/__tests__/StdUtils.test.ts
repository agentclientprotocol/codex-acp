import {PassThrough} from "node:stream";
import {describe, expect, it} from "vitest";
import {createJSONRPCReader} from "../StdUtils";

describe("createJSONRPCReader", () => {
    it("preserves UTF-8 characters split across stream chunks", async () => {
        const readable = new PassThrough();
        const reader = createJSONRPCReader(readable);
        const message = new Promise<unknown>((resolve) => {
            reader.listen(resolve);
        });
        const bytes = Buffer.from('{"id":1,"result":"通用谓词解析器"}\n');
        const character = Buffer.from("析");
        const splitAt = bytes.indexOf(character);

        readable.write(bytes.subarray(0, splitAt));
        for (const byte of character) {
            readable.write(Buffer.from([byte]));
        }
        readable.end(bytes.subarray(splitAt + character.length));

        await expect(message).resolves.toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            result: "通用谓词解析器",
        });
    });
});
