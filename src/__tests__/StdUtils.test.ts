import {PassThrough} from "node:stream";
import {describe, expect, it} from "vitest";
import {createJSONRPCReader} from "../StdUtils";

describe("createJSONRPCReader", () => {
    it("preserves UTF-8 characters split across chunks", () => {
        const readable = new PassThrough();
        const messages: unknown[] = [];
        const listener = createJSONRPCReader(readable).listen((message) => messages.push(message));
        const payload = Buffer.from(JSON.stringify({id: 1, result: {text: "服务治理需求"}}) + "\n");
        const character = Buffer.from("需");
        const characterOffset = payload.indexOf(character);

        readable.write(payload.subarray(0, characterOffset + 1));
        readable.write(payload.subarray(characterOffset + 1, characterOffset + 2));
        readable.write(payload.subarray(characterOffset + 2));

        expect(messages).toEqual([{
            jsonrpc: "2.0",
            id: 1,
            result: {text: "服务治理需求"},
        }]);

        listener.dispose();
        readable.destroy();
    });
});
