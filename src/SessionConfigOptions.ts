import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {isRecord} from "./permissions/json";

/** Validate the whole list before opening a session or applying any values. */
export function validateInitialConfigOptions(entries: unknown, protocolVersion: 1 | 2 = 1): void {
    if (entries == null) return;
    if (!Array.isArray(entries)) {
        throw RequestError.invalidParams(undefined, "configOptions must be a list");
    }
    const seen = new Set<string>();
    for (const entry of entries) {
        if (!isRecord(entry) || typeof entry["configId"] !== "string"
            || (protocolVersion === 2 && entry["type"] !== "id" && entry["type"] !== "boolean")
            || typeof entry["value"] !== (entry["type"] === "boolean" ? "boolean" : "string")) {
            throw RequestError.invalidParams(undefined, "Invalid initial config option");
        }
        if (seen.has(entry["configId"])) {
            throw RequestError.invalidParams(undefined, `Duplicate config option: ${entry["configId"]}`);
        }
        seen.add(entry["configId"]);
    }
}
