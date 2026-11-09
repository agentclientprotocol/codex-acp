import type {JsonValue} from "./app-server/serde_json/JsonValue";

/** A Codex `-c key=value` override, the value written as TOML. */
export function configOverride(key: string, value: JsonValue | undefined): string[] {
    return ["-c", `${key}=${toToml(value)}`];
}

// JSON strings, numbers, booleans, and arrays are already valid TOML; only objects need `key = value` syntax.
function toToml(value: JsonValue | undefined): string {
    if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
    if (value !== null && typeof value === "object") {
        return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toToml(item)}`).join(", ")} }`;
    }
    return JSON.stringify(value);
}

/** The provider routing an app-server process starts with: `-c` overrides, and the environment variables they read. */
export interface ProviderStartupConfig {
    args: string[];
    env: Record<string, string>;
}

export const NO_PROVIDER_STARTUP_CONFIG: ProviderStartupConfig = {args: [], env: {}};
