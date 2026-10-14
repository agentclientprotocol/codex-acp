import type {JsonObject} from "./CodexAcpClient";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

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
    return {sessionConfig, appServerStartupArgs: ["app-server", "-c", `hooks=${toToml(hooks)}`]};
}

// JSON strings, numbers, booleans, and arrays are already valid TOML; only objects need `key = value` syntax.
function toToml(value: JsonValue | undefined): string {
    if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
    if (value !== null && typeof value === "object") {
        return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toToml(item)}`).join(", ")} }`;
    }
    return JSON.stringify(value);
}
