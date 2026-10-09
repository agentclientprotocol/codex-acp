import type {ClientCapabilities} from "@agentclientprotocol/sdk";

/** Forces the receipt on (`true`, `1`) or off (`false`, `0`) for every client. */
export const TURN_CONFIGURATION_RECEIPT_ENV = "TURN_CONFIGURATION_RECEIPT";

/** The client declares `clientCapabilities._meta.codex.turnConfiguration: true`. */
export function clientRequestsTurnConfigurationReceipt(capabilities?: ClientCapabilities | null): boolean {
    const codex = capabilities?._meta?.["codex"];
    if (typeof codex !== "object" || codex === null || Array.isArray(codex)) {
        return false;
    }
    return (codex as Record<string, unknown>)["turnConfiguration"] === true;
}

/** See `docs/turn-configuration-receipt.md#activation`. */
export function turnConfigurationReceiptEnabled(capabilities?: ClientCapabilities | null): boolean {
    const configured = process.env[TURN_CONFIGURATION_RECEIPT_ENV]?.trim().toLowerCase();
    if (configured === "true" || configured === "1") {
        return true;
    }
    if (configured === "false" || configured === "0") {
        return false;
    }
    return clientRequestsTurnConfigurationReceipt(capabilities);
}
