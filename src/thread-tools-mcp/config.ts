import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import {THREAD_TOOLS_MCP_NAME} from "./catalog";

type JsonObject = {[key: string]: JsonValue | undefined};

export class CodexThreadToolsConfigPolicy {
    constructor(private readonly client: CodexAppServerClient) {}

    async validate(projectPath: string, requestedServerNames: string[]): Promise<Set<string>> {
        if (requestedServerNames.includes(THREAD_TOOLS_MCP_NAME)) {
            throw new Error(`The ACP MCP server name ${THREAD_TOOLS_MCP_NAME} is reserved`);
        }
        const configured = await this.configuredNames(projectPath);
        if (configured.effective.has(THREAD_TOOLS_MCP_NAME)) {
            throw new Error(`A configured MCP server already owns the ${THREAD_TOOLS_MCP_NAME} namespace`);
        }
        return configured.all;
    }

    private async configuredNames(projectPath: string): Promise<{effective: Set<string>, all: Set<string>}> {
        const response = await this.client.configRead({includeLayers: true, cwd: projectPath});
        const effectiveServers = response?.config?.["mcp_servers"];
        const effective = new Set(isJsonObject(effectiveServers) ? Object.keys(effectiveServers) : []);
        const layerNames = (response?.layers ?? []).flatMap(layer => {
            if (!isJsonObject(layer.config)) return [];
            const servers = layer.config["mcp_servers"];
            return isJsonObject(servers) ? Object.keys(servers) : [];
        });
        return {effective, all: new Set([...effective, ...layerNames])};
    }
}

function isJsonObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
