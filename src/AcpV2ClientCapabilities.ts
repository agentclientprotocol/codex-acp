import type * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";

/**
 * Maps v2 client capabilities onto the v1 shape the capability readers use, so each reader
 * does not need a v2 fork.
 *
 * Only fields that exist on v2 carry over, at the same relative path: `elicitation`,
 * `auth._meta` (gateway) and `_meta` (JetBrains AIR). v1-only probes (`plan`, `session.*`,
 * `subagents`) stay absent because v2 has no such fields.
 */
export function toV1ClientCapabilitiesView(
    capabilities: acpV2.ClientCapabilities | null | undefined,
): acp.ClientCapabilities | null {
    if (!capabilities) {
        return null;
    }
    const view: acp.ClientCapabilities = {};
    if (capabilities.elicitation) {
        view.elicitation = capabilities.elicitation;
    }
    if (capabilities.auth) {
        const {terminal, _meta} = capabilities.auth;
        view.auth = {
            ...(terminal != null ? {terminal: true} : {}),
            ...(_meta != null ? {_meta} : {}),
        };
    }
    if (capabilities._meta != null) {
        view._meta = capabilities._meta;
    }
    return view;
}
