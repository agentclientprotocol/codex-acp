import {describe, expect, it, vi} from "vitest";
import {connectSession, cwd, sessionId} from "./v2-prompt-harness";

describe.each([1, 2] as const)("ACP v%s session paths", version => {
    it.each(["session/new", "session/resume", "session/fork", "session/list", ...(version === 1 ? ["session/load"] : [])])(
        "rejects a relative cwd before dispatching %s", async method => {
            const h = await connectSession(version);
            try {
                const spies = [vi.spyOn(h.agent, "newSession"), vi.spyOn(h.agent, "resumeSession"),
                    vi.spyOn(h.agent, "forkSession"), vi.spyOn(h.agent, "loadSession"), vi.spyOn(h.agent, "listSessions")];
                await expect(h.request(method, {sessionId, cwd: "relative", mcpServers: []}))
                    .rejects.toMatchObject({code: -32602});
                for (const spy of spies) expect(spy).not.toHaveBeenCalled();
            } finally { h.connection.close(); }
        },
    );

    it.each(["session/new", "session/resume", "session/fork", ...(version === 1 ? ["session/load"] : [])])(
        "rejects relative additional roots before dispatching %s", async method => {
            const h = await connectSession(version);
            try {
                await expect(h.request(method, {sessionId, cwd, mcpServers: [], additionalDirectories: ["relative"]}))
                    .rejects.toMatchObject({code: -32602});
            } finally { h.connection.close(); }
        },
    );

    it("does not interpret unknown fields as workspace settings", async () => {
        const h = await connectSession(version);
        try {
            await expect(h.request("session/list", {cwd, additionalDirectories: ["relative"]}))
                .resolves.toHaveProperty("sessions");
            await expect(h.request("session/set_config_option", {
                sessionId, configId: "mode", type: "id", value: "agent", cwd: "relative",
            })).resolves.toHaveProperty("configOptions");
        } finally { h.connection.close(); }
    });
});
