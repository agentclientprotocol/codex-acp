import type {JsonObject} from "./CodexAcpClient";
import {configOverride} from "./CodexConfigOverride";

export type PreparedCodexHookConfig = {
    sessionConfig: JsonObject | undefined;
    appServerStartupArgs: string[];
};

/**
 * Moves `hooks` from the session config to an App Server `-c` override, so they exist before any thread starts.
 * Codex validates the value itself: malformed hooks stop App Server at startup, and `initialize` reports its stderr.
 */
export function prepareCodexHookConfig(config?: JsonObject): PreparedCodexHookConfig {
    if (config?.["hooks"] === undefined) return {sessionConfig: config, appServerStartupArgs: ["app-server"]};
    const {hooks, ...sessionConfig} = config;
    return {sessionConfig, appServerStartupArgs: ["app-server", ...configOverride("hooks", hooks)]};
}
