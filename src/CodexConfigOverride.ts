import type {ConfigLayer, ConfigLayerSource, ConfigReadResponse} from "./app-server/v2";
import {arePathsEqual} from "./PathUtils";
import {recordOrNull} from "./permissions/json";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {JsonObject} from "./CodexAcpClient";

function aboveSessionFlags(source?: ConfigLayerSource): boolean {
    return source?.type === "legacyManagedConfigTomlFromFile" || source?.type === "legacyManagedConfigTomlFromMdm";
}

/** config/read exposes a disabled layer's inherited trust key only in its reason. Setup trusts its workspace roots. */
function enabledDuringSetup(layer: ConfigLayer, response: ConfigReadResponse, roots: string[]): boolean {
    const {name, disabledReason} = layer;
    if (disabledReason == null) return true;
    if (name.type !== "project") return false;
    return roots.some(root => !aboveSessionFlags(response.origins?.[`projects.${root}.trust_level`]?.name) && (
        arePathsEqual(name.dotCodexFolder, `${root}/.codex`)
        || disabledReason.includes(`, add ${root} as a trusted project in `)
        || disabledReason.startsWith(`${root} is marked as untrusted in the effective configuration.`)
    ));
}

/** Resolve workspace options from highest to lowest precedence, including the overrides sent on thread setup. */
export function workspaceOptionReader(response: ConfigReadResponse, roots: string[], overrides: JsonObject) {
    const layers = (response?.layers ?? []).filter(layer => enabledDuringSetup(layer, response, roots));
    const configs = layers.map(layer => recordOrNull(layer.config));
    const position = layers.findIndex(layer => !aboveSessionFlags(layer.name));
    configs.splice(position === -1 ? configs.length : position, 0, overrides);
    configs.push(response?.config);
    return <T>(read: (config: Record<string, unknown>) => T | undefined): T | undefined => {
        for (const config of configs) {
            if (!config) continue;
            const value = read(config);
            if (value !== undefined) return value;
        }
        return undefined;
    };
}

/** A Codex `-c key=value` override, the value written as TOML. */
export function configOverride(key: string, value: JsonValue | undefined): string[] {
    return ["-c", `${key}=${toToml(value)}`];
}

/**
 * Fold dotted overrides into the tables the adapter is about to edit. Codex applies thread overrides
 * from an unordered map: sending both `mcp_servers` and `mcp_servers.x.url` could pair a URL with
 * the wrong credentials. More specific keys win; do not mutate the config shared by other threads.
 */
export function expandConfigTables(config: JsonObject, ...tables: string[]): JsonObject {
    const paths = Object.keys(config).filter(key => tables.some(table => key.startsWith(`${table}.`))).sort();
    if (paths.length === 0) return config;
    const result = {...config};
    for (const path of paths) {
        const parts = path.split(".");
        const field = parts.pop()!;
        let parent = result;
        for (const part of parts) {
            const existing = parent[part];
            // Server and header names are data, including names such as "__proto__".
            parent = parent[part] = Object.assign(Object.create(null),
                existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {});
        }
        parent[field] = result[path];
        delete result[path];
    }
    return result;
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
