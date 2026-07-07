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
    _clientCapabilities?: acp.ClientCapabilities | null
): InitializeCapabilities | null {
    // Do not opt into app-server experimental APIs just because the ACP client supports elicitation.
    // The handlers can stay in place, but this keeps request_user_input dormant until explicitly enabled.
    return null;
}
