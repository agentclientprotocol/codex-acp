import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../CodexAppServerClient";
import { TitleGenerator } from "../TitleGenerator";

describe("TitleGenerator", () => {
    afterEach(() => vi.unstubAllEnvs());

    function client() {
        return {
            threadStart: vi.fn().mockResolvedValue({ thread: { id: "title-thread" } }),
            runTurn: vi.fn().mockResolvedValue({
                turn: { items: [{ type: "agentMessage", text: '{"title":"Review project memory"}' }] },
            }),
            threadSetName: vi.fn().mockResolvedValue({}),
        };
    }

    it("starts no title thread or model request when disabled", async () => {
        vi.stubEnv("ACP_DISABLE_TITLE_GENERATION", "1");
        const codex = client();
        const titles = new TitleGenerator(
            codex as unknown as CodexAppServerClient, "session", "/workspace", () => "unset",
        );

        titles.onTurnCompleted("Review the project's memory notes");
        titles.onTurnCompleted("Review another note");
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(codex.threadStart).not.toHaveBeenCalled();
        expect(codex.runTurn).not.toHaveBeenCalled();
        expect(codex.threadSetName).not.toHaveBeenCalled();
    });

    it.each([undefined, "0"])("still generates a title when the switch is %s", async value => {
        vi.stubEnv("ACP_DISABLE_TITLE_GENERATION", value);
        const codex = client();
        const titles = new TitleGenerator(
            codex as unknown as CodexAppServerClient, "session", "/workspace", () => "unset",
        );

        titles.onTurnCompleted("Review the project's memory notes");
        await vi.waitFor(() => expect(codex.threadSetName).toHaveBeenCalledWith({
            threadId: "session",
            name: "Review project memory",
        }));

        expect(codex.threadStart).toHaveBeenCalledExactlyOnceWith({
            cwd: "/workspace",
            ephemeral: true,
        });
        expect(codex.runTurn).toHaveBeenCalledTimes(1);
    });
});
