import {describe, expect, it} from "vitest";
import {prepareCodexStartupConfig} from "../CodexStartupConfig";

describe("Codex App Server startup config", () => {
    it("moves thread_unload_delay_secs to App Server startup", () => {
        expect(prepareCodexStartupConfig({model: "gpt-5", thread_unload_delay_secs: 5})).toEqual({
            sessionConfig: {model: "gpt-5"},
            appServerStartupArgs: ["app-server", "-c", "thread_unload_delay_secs=5"],
        });
    });

    it("keeps the default startup without config", () => {
        expect(prepareCodexStartupConfig(undefined)).toEqual({
            sessionConfig: undefined,
            appServerStartupArgs: ["app-server"],
        });
    });
});
