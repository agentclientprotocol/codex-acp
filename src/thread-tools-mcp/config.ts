import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {JsonValue} from "../app-server/serde_json/JsonValue";
import {THREAD_TOOLS_MCP_NAME} from "./catalog";

type JsonObject = {[key: string]: JsonValue | undefined};

export class CodexThreadToolsConfigPolicy {
    private readonly configuredServerNames = new Map<string, Set<string>>();
    private requirementsChecked = false;

    constructor(private readonly client: CodexAppServerClient) {}

    async validate(projectPath: string, requestedServerNames: string[]): Promise<Set<string>> {
        if (requestedServerNames.includes(THREAD_TOOLS_MCP_NAME)) {
            throw new Error(`The ACP MCP server name ${THREAD_TOOLS_MCP_NAME} is reserved`);
        }
        const existingNames = await this.configuredNames(projectPath);
        if (existingNames.has(THREAD_TOOLS_MCP_NAME)) {
            throw new Error(`A configured MCP server already owns the ${THREAD_TOOLS_MCP_NAME} namespace`);
        }
        if (!this.requirementsChecked) {
            await this.validateManagedRequirements();
            this.requirementsChecked = true;
        }
        return existingNames;
    }

    private async configuredNames(projectPath: string): Promise<Set<string>> {
        const cached = this.configuredServerNames.get(projectPath);
        if (cached !== undefined) return cached;
        const response = await this.client.configRead({includeLayers: true, cwd: projectPath});
        const effectiveServers = response?.config?.["mcp_servers"];
        const layerServers = (response?.layers ?? []).map(layer => {
            return isJsonObject(layer.config) ? layer.config["mcp_servers"] : undefined;
        });
        const configuredServers = [effectiveServers, ...layerServers].filter(isJsonObject);
        const names = new Set(configuredServers.flatMap(server => Object.keys(server)));
        this.configuredServerNames.set(projectPath, names);
        return names;
    }

    private async validateManagedRequirements(): Promise<void> {
        let response: unknown;
        try {
            response = await this.client.connection.sendRequest("configRequirements/read");
        } catch (error) {
            if (isMethodUnavailable(error, "configRequirements/read")) return;
            throw error;
        }
        if (!isJsonObject(response) || !isJsonObject(response["requirements"])) return;
        const requirements = response["requirements"];
        const mcpServers = requirements["mcpServers"] ?? requirements["mcp_servers"];
        if (mcpServers === undefined) return;
        if (!isJsonObject(mcpServers) || !Object.hasOwn(mcpServers, THREAD_TOOLS_MCP_NAME)) {
            throw new Error("Managed MCP requirements do not permit the Codex ACP thread-tools server");
        }
    }
}

function isJsonObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMethodUnavailable(error: unknown, method: string): boolean {
    if (isJsonObject(error) && error["code"] === -32601) return true;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes(method.toLowerCase()) && message.includes("not found");
}
