import type {ClientCapabilities} from "@agentclientprotocol/sdk";

/**
 * Wire names for the versioned JetBrains AIR ACP extension.
 *
 * `jetbrains.air` is a protocol namespace, not user-facing branding: `jetbrains`
 * owns the non-standard contract and `air` identifies the client that defines its
 * rendering semantics. Keeping both levels prevents unrelated JetBrains ACP clients
 * from accidentally interpreting or colliding with this metadata.
 */
export const JETBRAINS_META_KEY = "jetbrains";
export const AIR_META_KEY = "air";
export const AIR_EXTENSION_VERSION_KEY = "version";
export const AIR_EXTENSION_CAPABILITIES_KEY = "capabilities";
export const AIR_DIFF_STATS_KEY = "diffStats";
export const AIR_SESSION_FAILURE_KEY = "sessionFailure";
export const AIR_AGENT_FILE_CHANGE_REPORT_KEY = "agentFileChangeReport";
export const AIR_NATIVE_SUBAGENT_SESSIONS_KEY = "nativeSubagentSessions";
export const AIR_ASYNC_TASKS_KEY = "asyncTasks";
export const AIR_RECOMMENDED_CONFIG_VALUE_KEY = "recommendedValue";
export const AIR_ASYNC_TASKS_BACKGROUNDED_KEY = "backgrounded";
export const AIR_AGENT_FILE_CHANGE_REPORT_REQUEST_KEY = "agentFileChangeReportRequest";
export const AIR_EXTENSION_VERSION = 1;

/** Merge one AIR payload into metadata while preserving other object namespaces. */
export function withAirMeta(
    meta: Record<string, unknown> | null | undefined,
    key: string,
    value: unknown,
): Record<string, unknown> {
    const root = asRecord(meta);
    const jetbrains = asRecord(root[JETBRAINS_META_KEY]);
    const air = asRecord(jetbrains[AIR_META_KEY]);
    return {
        ...root,
        [JETBRAINS_META_KEY]: {
            ...jetbrains,
            [AIR_META_KEY]: {
                ...air,
                [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                [key]: value,
            },
        },
    };
}

export function clientSupportsAirCapability(
    capabilities: ClientCapabilities | null | undefined,
    capability: string,
): boolean {
    const meta = asRecord(capabilities?._meta);
    const jetbrains = asRecord(meta[JETBRAINS_META_KEY]);
    const air = asRecord(jetbrains[AIR_META_KEY]);
    const version = air[AIR_EXTENSION_VERSION_KEY];
    const supported = air[AIR_EXTENSION_CAPABILITIES_KEY];
    return typeof version === "number"
        && Number.isInteger(version)
        && version >= AIR_EXTENSION_VERSION
        && Array.isArray(supported)
        && supported.includes(capability);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
