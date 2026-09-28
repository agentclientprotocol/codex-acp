import type * as acp from "@agentclientprotocol/sdk";

/**
 * Client capability (`clientCapabilities._meta.continueOnReject: true` on `initialize`) that asks the
 * adapter to offer Codex's `decline` decision before `cancel` when Codex's own decision set lacks it.
 * See docs/permission-extension.md.
 */
export const CONTINUE_ON_REJECT_CAPABILITY_KEY = "continueOnReject";

export function clientSupportsContinueOnReject(
    clientCapabilities?: acp.ClientCapabilities | null,
): boolean {
    return clientCapabilities?._meta?.[CONTINUE_ON_REJECT_CAPABILITY_KEY] === true;
}
