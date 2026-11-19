import {describe, expect, it, vi} from "vitest";
import {codexResponse, connectSession, createThread, cwd, sessionId} from "./v2-prompt-harness";

describe.each([1, 2] as const)("ACP v%s SDK upgrade capabilities", version => {
    it("advertises title support without claiming other newly exposed SDK methods", async () => {
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
            expect(session.options).toBeUndefined();
            expect(session.prompt?.skill).toBeUndefined();
            expect(capabilities.auth.status).toBeUndefined();
            for (const method of ["auth/status", "session/status", "session/archive", "session/unarchive"]) {
                await expect(h.request(method, {sessionId})).rejects.toMatchObject({code: -32601});
            }
            if (version === 2) {
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
