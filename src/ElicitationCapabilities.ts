import type * as acp from "@agentclientprotocol/sdk";
import type {InitializeCapabilities} from "./app-server";

export function clientSupportsFormElicitation(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    return clientCapabilities?.elicitation?.form != null;
}

export function clientSupportsUrlElicitation(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    return clientCapabilities?.elicitation?.url != null;
}

export function createAppServerInitializeCapabilities(
    clientCapabilities?: acp.ClientCapabilities | null
): InitializeCapabilities | null {
    if (!clientSupportsFormElicitation(clientCapabilities)) {
        return null;
    }

    return {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
    };
}
