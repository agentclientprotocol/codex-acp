import {describe, expect, it} from "vitest";
import {readSessionInstructionAppend, SYSTEM_PROMPT_CAPABILITY} from "../SessionInstructions";

describe("session instruction metadata", () => {
    it("preserves explicit empty append for native reset",()=>{expect(readSessionInstructionAppend({systemPrompt:{append:""}})).toBe("");});
    it("preserves text exactly and counts UTF-8 bytes at the boundary", () => {
        const boundary = "é".repeat(SYSTEM_PROMPT_CAPABILITY.maxBytes / 2);
        expect(readSessionInstructionAppend({systemPrompt:{append:boundary}})).toBe(boundary);
        expect(() => readSessionInstructionAppend({systemPrompt:{append:boundary + "a"}})).toThrow(/UTF-8/);
        expect(readSessionInstructionAppend({systemPrompt:{append:"  role\n"}})).toBe("  role\n");
    });
    it.each([undefined, null, {}])("ignores absent append %j", meta => {
        expect(readSessionInstructionAppend(meta)).toBeUndefined();
    });
    it.each([null, "replacement", [], {}, {append:null}, {append:42}, {append:"role",override:true}])("rejects malformed or unsupported forms %j", systemPrompt => {
        expect(() => readSessionInstructionAppend({systemPrompt})).toThrow();
    });
});
