import {PassThrough} from "node:stream";
import {describe, expect, it} from "vitest";
import {createJSONRPCWriter, withDeadline, writeNdjsonLine} from "../StdUtils";
import {resolveRpcTimeoutMs} from "../CodexAppServerClient";

describe("stdio helpers", () => {
    it("rejects a deadline when the work never finishes", async () => {
        await expect(withDeadline(new Promise(() => {}), 10, "Codex RPC turn/start"))
            .rejects.toThrow("Codex RPC turn/start timed out after 10ms");
    });

    it("writes newline JSON and waits when the pipe asks for drain", async () => {
        const writable = new PassThrough({highWaterMark: 8});
        const chunks: string[] = [];
        writable.on("data", (chunk) => chunks.push(String(chunk)));
        await writeNdjsonLine(writable, '{"ok":true}\n');
        expect(chunks.join("")).toBe('{"ok":true}\n');
    });

    it("fails the JSON-RPC writer instead of swallowing a closed pipe", async () => {
        const writable = new PassThrough();
        writable.end();
        const writer = createJSONRPCWriter(writable);
        await expect(writer.write({jsonrpc: "2.0", method: "turn/start", id: 1} as any))
            .rejects.toThrow("Codex app-server stdin is not writable");
    });

    it("uses a shorter timeout for interrupt and honors CODEX_RPC_TIMEOUT_MS", () => {
        expect(resolveRpcTimeoutMs("turn/start", {})).toBe(60_000);
        expect(resolveRpcTimeoutMs("turn/interrupt", {})).toBe(15_000);
        expect(resolveRpcTimeoutMs("turn/start", {CODEX_RPC_TIMEOUT_MS: "2500"})).toBe(2500);
    });
});
