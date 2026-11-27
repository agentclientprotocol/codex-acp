import {describe, expect, it, vi} from "vitest";
import {createRequire} from "node:module";
import {Ajv2020} from "ajv/dist/2020.js";
import {codexResponse, connectSession, createThread, cwd, sessionId} from "./v2-prompt-harness";

it.each([false, true])("v2 delete succeeds when the session is already gone (sessionIndex: %s)", async indexed => {
    const missing = vi.fn(async () => { throw new Error("thread not found: gone"); });
    const h = await connectSession(2, {
        clientCapabilities: indexed ? {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}} : {},
        codexResponses: {[indexed ? "thread/delete" : "thread/archive"]: missing},
    });
    try {
        await expect(h.request("session/delete", {sessionId: "gone"})).resolves.toEqual({});
        expect(missing).toHaveBeenCalledOnce();
    } finally { h.connection.close(); }
});

it("sends method- and direction-valid v2 frames through setup, local work, replay and close", async () => {
    const schema = createRequire(import.meta.url)("@agentclientprotocol/sdk/schema/v2/schema.unstable.json");
    const ajv = new Ajv2020({strict: false, logger: false});
    ajv.addSchema(schema, "acp");
    const validate = ajv.getSchema("acp#agentToClient")!;
    const h = await connectSession();
    try {
        await h.sendPrompt([{type: "text", text: "/status"}]);
        await h.promptRunFinished();
        await h.request("session/resume", {sessionId, cwd, replayFrom: {type: "start"}});
        await h.request("session/close", {sessionId});
        for (const frame of h.wireMessages) {
            expect(validate(frame), `${JSON.stringify(frame)}: ${ajv.errorsText(validate.errors)}`).toBe(true);
        }
    } finally { h.connection.close(); }
});

describe.each([1, 2] as const)("ACP v%s SDK upgrade capabilities", version => {
    it("advertises title, options and auth status support without claiming other newly exposed SDK methods", async () => {
        const h = await connectSession(version);
        try {
            const initialize = h.wireMessages.find(frame =>
                "result" in frame && frame.result !== null && typeof frame.result === "object"
                && "protocolVersion" in frame.result) as {result: Record<string, any>};
            const capabilities = version === 1 ? initialize.result["agentCapabilities"] : initialize.result["capabilities"];
            const session = version === 1 ? capabilities.sessionCapabilities : capabilities.session;
            expect(session.title).toEqual({});
            expect(session.archive).toBeUndefined();
            expect(session.status).toBeUndefined();
            expect(session.options).toEqual({});
            expect(session.prompt?.skill).toBeUndefined();
            expect(capabilities.auth.status).toEqual({});
            for (const method of ["session/status", "session/archive", "session/unarchive"]) {
                await expect(h.request(method, {sessionId})).rejects.toMatchObject({code: -32601});
            }
            if (version === 2) {
                expect(h.setupUpdates.filter(update => update.sessionUpdate === "state_update")
                    .every(update => Array.isArray((update as {background?: unknown}).background))).toBe(true);
                await expect(h.request("tool_call/cancel", {sessionId, toolCallId: "tool"})).rejects.toMatchObject({code: -32601});
                await expect(h.request("terminal/cancel", {sessionId, terminalId: "unknown"})).rejects.toMatchObject({code: -32602});
            }
        } finally { h.connection.close(); }
    });

    it("rejects an unissued fork cursor without silently creating a full fork", async () => {
        const h = await connectSession(version);
        try {
            const fork = vi.fn(async () => ({
                ...codexResponse("thread/start") as object, thread: {...createThread(), id: "fork"},
            }));
            h.setCodexResponse("thread/fork", fork);
            const params = {sessionId, cwd, mcpServers: []};
            for (const cursorId of ["unknown", 17]) {
                await expect(h.request("session/fork", {...params, cursorId})).rejects.toMatchObject({code: -32602});
            }
            expect(fork).not.toHaveBeenCalled();
            await expect(h.request("session/fork", {...params, cursorId: null})).resolves.toMatchObject({sessionId: "fork"});
            expect(fork).toHaveBeenCalledOnce();
        } finally { h.connection.close(); }
    });
});
