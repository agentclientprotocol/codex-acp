import type * as acp from "@agentclientprotocol/sdk";

export function isJetBrains2026_1Client(clientInfo: acp.Implementation | null): boolean {
    if (!clientInfo) {
        return false;
    }

    const platform = clientInfo._meta?.["platform"];
    const isIntelliJPlatform = platform === "intellij";
    const isJetBrainsClient = clientInfo.name.startsWith("JetBrains");
    return (isIntelliJPlatform || isJetBrainsClient) && clientInfo.version.startsWith("2026.1");
}
