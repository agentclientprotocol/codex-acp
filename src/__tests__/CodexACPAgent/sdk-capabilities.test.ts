import {describe, expect, it} from "vitest";
import {connectSession, sessionId} from "./v2-prompt-harness";

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
            expect(capabilities.auth.status).toBeUndefined();
            for (const method of ["auth/status", "session/status", "session/archive", "session/unarchive"]) {
                await expect(h.request(method, {sessionId})).rejects.toMatchObject({code: -32601});
            }
            if (version === 2) {
                expect(h.setupUpdates.filter(update => update.sessionUpdate === "state_update")
                    .every(update => !("background" in update))).toBe(true);
                for (const method of ["tool_call/cancel", "terminal/cancel"]) {
                    await expect(h.request(method, {sessionId, toolCallId: "tool", terminalId: "terminal"}))
                        .rejects.toMatchObject({code: -32602});
                }
            }
        } finally { h.connection.close(); }
    });
});
