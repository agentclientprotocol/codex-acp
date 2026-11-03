import type {JsonObject} from "./CodexAcpClient";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

export type PreparedCodexStartupConfig = {
    sessionConfig: JsonObject | undefined;
    appServerStartupArgs: string[];
};

/**
 * Keys that App Server reads from its own config, never from the config of a thread.
 * `hooks` must exist before any thread starts. `thread_unload_delay_secs` applies to every thread App Server unloads.
 */
const APP_SERVER_STARTUP_KEYS = new Set(["hooks", "thread_unload_delay_secs"]);

/**
 * Moves the App Server keys from the session config to App Server `-c` overrides.
 * Codex validates the values itself: a malformed value stops App Server at startup, and `initialize` reports its stderr.
 */
export function prepareCodexStartupConfig(config?: JsonObject): PreparedCodexStartupConfig {
    const appServerStartupArgs = ["app-server"];
    if (config === undefined) return {sessionConfig: config, appServerStartupArgs};
    const sessionConfig: JsonObject = {};
    for (const [key, value] of Object.entries(config)) {
        if (value !== undefined && APP_SERVER_STARTUP_KEYS.has(key)) {
            appServerStartupArgs.push("-c", `${key}=${toToml(value)}`);
        } else {
            sessionConfig[key] = value;
        }
    }
    return {sessionConfig, appServerStartupArgs};
}

// JSON strings, numbers, booleans, and arrays are already valid TOML; only objects need `key = value` syntax.
function toToml(value: JsonValue | undefined): string {
    if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
    if (value !== null && typeof value === "object") {
        return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toToml(item)}`).join(", ")} }`;
    }
    return JSON.stringify(value);
}
