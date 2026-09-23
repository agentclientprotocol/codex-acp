import type * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";

/**
 * Maps v2 client capabilities onto the v1 shape the capability readers use, so each reader
 * does not need a v2 fork.
 *
 * Fields that exist on v2 carry over at the same relative path: `elicitation`, `auth._meta`
 * (gateway) and `_meta` (JetBrains AIR). Plan updates, compaction and notices need no client
 * capability on v2, so their v1 probes (`plan`, `session.compaction`, `session.notices`) are
 * always set. `subagents` stays absent.
 */
export function toV1ClientCapabilitiesView(
    capabilities: acpV2.ClientCapabilities | null | undefined,
): acp.ClientCapabilities {
    const view: acp.ClientCapabilities = {
        plan: {},
        session: {compaction: {}, notices: {}},
    };
    if (!capabilities) {
        return view;
    }
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
