import {RequestError} from "@agentclientprotocol/sdk";
import {z} from "zod";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {SessionState} from "./CodexAcpServer";
import {listMcpServerStatus} from "./mcp/McpServerStatusList";

export const RUNTIME_READ_METHOD = "_session/runtime/read";
export const RUNTIME_CONTROL_METHOD = "_session/runtime/control";
export const runtimeReadParser = z.object({
    sessionId: z.string().trim().min(1),
    resource: z.enum(["context", "usage", "mcp", "commands", "plugins"]),
}).strict();
export const runtimeControlParser = z.object({
    sessionId: z.string().trim().min(1),
    action: z.enum(["reloadSkills", "reconnectMcp", "reloadPlugins"]),
}).strict();
export type RuntimeReadRequest = z.infer<typeof runtimeReadParser>;
export type RuntimeControlRequest = z.infer<typeof runtimeControlParser>;
export type RuntimeResponse =
    | {version: 1, status: "ok", data: unknown}
    | {version: 1, status: "unavailable", reason: "timeout" | "cancelled" | "stale"};

export function runtimeCapability() {
    return {
        version: 1,
        readMethod: RUNTIME_READ_METHOD,
        controlMethod: RUNTIME_CONTROL_METHOD,
        reads: ["context", "usage", "mcp", "commands", "plugins"],
        controls: ["reloadSkills", "reconnectMcp", "reloadPlugins"],
    };
}

export type RuntimeSession = Pick<SessionState,
    "sessionId" | "cwd" | "additionalDirectories" | "currentModelId" |
    "lastTokenUsage" | "totalTokenUsage" | "modelContextWindow" | "rateLimits"
>;
type RuntimeClient = Pick<CodexAcpClient, "listSkills" | "listMcpServers" | "reloadMcpServers" | "installedPlugins" | "reconcilePlugins">;

/** Do not synthesize prompt categories from aggregate token usage. Null means
 * the native runtime has not supplied the measurement, not zero tokens. */
export async function readRuntime(
    client: RuntimeClient,
    session: RuntimeSession,
    request: RuntimeReadRequest,
    signal: AbortSignal,
    isCurrent: () => boolean = () => true,
    timeoutMs = 5000,
): Promise<RuntimeResponse> {
    if (request.sessionId !== session.sessionId) throw RequestError.invalidParams(undefined, "Session mismatch");
    if (signal.aborted) return {version: 1, status: "unavailable", reason: "cancelled"};
    if (!isCurrent()) return {version: 1, status: "unavailable", reason: "stale"};
    const operation = async (): Promise<unknown> => {
        switch (request.resource) {
            case "context": return {
                model: session.currentModelId,
                totalTokens: session.lastTokenUsage?.totalTokens ?? null,
                maxTokens: session.modelContextWindow,
                categories: null,
                source: "last_native_usage_event",
            };
            case "usage": return {last: session.lastTokenUsage, total: session.totalTokenUsage, rateLimits: session.rateLimits};
            case "plugins": return await client.installedPlugins([session.cwd, ...session.additionalDirectories]);
            case "commands": return await client.listSkills({cwds: [session.cwd, ...session.additionalDirectories]});
            case "mcp": {
                // The existing paginated reader takes only listMcpServers in practice.
                const servers = await listMcpServerStatus(client as CodexAcpClient, session.sessionId);
                return servers.map(server => ({
                    name: server.name,
                    status: server.runtimeStatus,
                    authStatus: server.authStatus,
                    pluginId: server.pluginId,
                    serverInfo: server.serverInfo,
                    toolNames: Object.keys(server.tools),
                }));
            }
        }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        const result = await Promise.race<RuntimeResponse>([
            operation().then(data => ({version: 1, status: "ok", data})),
            new Promise(resolve => {
                timer = setTimeout(() => resolve({version: 1, status: "unavailable", reason: "timeout"}), timeoutMs);
                timer.unref?.();
            }),
            new Promise(resolve => {
                onAbort = () => resolve({version: 1, status: "unavailable", reason: "cancelled"});
                signal.addEventListener("abort", onAbort, {once: true});
            }),
        ]);
        return isCurrent() ? result : {version: 1, status: "unavailable", reason: "stale"};
    } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

/** The server must retain its lifecycle lease until native completion.
 * reloadMcpServers is process-wide: use the provider barrier, not just a
 * per-session guard, and do not claim the connections are ready from its ack. */
export async function controlRuntime(
    client: RuntimeClient,
    session: RuntimeSession,
    request: RuntimeControlRequest,
): Promise<RuntimeResponse> {
    if (request.sessionId !== session.sessionId) throw RequestError.invalidParams(undefined, "Session mismatch");
    switch (request.action) {
        case "reloadSkills": return {
            version: 1, status: "ok",
            data: await client.listSkills({cwds: [session.cwd, ...session.additionalDirectories], forceReload: true}),
        };
        case "reloadPlugins":
            return {version: 1, status: "ok", data: {...await client.reconcilePlugins(), scope: "provider", runtimeReady: false}};
        case "reconnectMcp":
            await client.reloadMcpServers();
            return {version: 1, status: "ok", data: {completed: true, scope: "provider", connectionsReady: false}};
    }
}
