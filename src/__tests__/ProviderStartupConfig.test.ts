import {describe, expect, it} from "vitest";
import {providerStartupConfig, type JsonObject} from "../CodexAcpClient";

const definition = {
    name: "Corp",
    base_url: "https://llm.corp/v1",
    wire_api: "responses",
    http_headers: {Authorization: "Bearer k"},
    env_http_headers: {"X-Org": "CORP_ORG"},
};

describe("providerStartupConfig", () => {
    it.each<[string, string | null, JsonObject]>([
        ["no provider", null, {model: "gpt-5"}],
        ["a launch option provider that the user's Codex config defines", "corp", {}],
        ["a launch option provider defined in the session config", "corp", {model_provider: "other", model_providers: {corp: definition}}],
        ["model_provider of the session config", null, {model_provider: "corp", model_providers: {corp: definition}}],
    ])("starts the app-server with %s", async (name, modelProvider, config) => {
        const startupConfig = providerStartupConfig(modelProvider, config, null);

        await expect(`${JSON.stringify(startupConfig, null, 2)}\n`)
            .toMatchFileSnapshot(`data/provider-startup-config/${name.replaceAll(" ", "-").replaceAll("'", "")}.json`);
    });
});
