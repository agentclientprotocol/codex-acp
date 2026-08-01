import type * as acp from "@agentclientprotocol/sdk";

export function clientSupportsPlanUpdates(
    clientCapabilities?: acp.ClientCapabilities | null,
): boolean {
    return clientCapabilities?.plan != null;
}
