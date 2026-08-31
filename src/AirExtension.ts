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
export const AIR_SESSION_FAILURE_KEY = "sessionFailure";
export const AIR_AGENT_FILE_CHANGE_REPORT_KEY = "agentFileChangeReport";
export const AIR_NATIVE_SUBAGENT_SESSIONS_KEY = "nativeSubagentSessions";
export const AIR_AGENT_FILE_CHANGE_REPORT_REQUEST_KEY = "agentFileChangeReportRequest";
export const AIR_EXTENSION_VERSION = 1;

export function clientSupportsAirCapability(
    capabilities: ClientCapabilities | null | undefined,
    capability: string,
): boolean {
    const jetbrains = capabilities?._meta?.[JETBRAINS_META_KEY] as Record<string, unknown> | undefined;
    const air = jetbrains?.[AIR_META_KEY] as Record<string, unknown> | undefined;
    const version = air?.[AIR_EXTENSION_VERSION_KEY];
    const supported = air?.[AIR_EXTENSION_CAPABILITIES_KEY];
    return typeof version === "number"
        && Number.isInteger(version)
        && version >= AIR_EXTENSION_VERSION
        && Array.isArray(supported)
        && supported.includes(capability);
}
