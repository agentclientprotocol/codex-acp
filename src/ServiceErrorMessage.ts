const SERVICE_ERROR_TYPES = new Set([
    "invalid_request_error",
    "server_error",
    "rate_limit_error",
    "insufficient_quota",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "conflict_error",
    "overloaded_error",
]);

const INVALID_ENCRYPTED_CONTENT_CODE = "invalid_encrypted_content";

// Codex resends the encrypted reasoning of earlier turns, and only the provider that encrypted it can read it.
const INVALID_ENCRYPTED_CONTENT_MESSAGE = "The current provider can't read this thread's earlier reasoning, "
    + "which another provider or account encrypted. This happens after the provider changes in a thread. "
    + "Switch back to the previous provider or start a new thread.";

/**
 * Reads the message of a known service error envelope, or adds a human-readable explanation.
 */
export function readableServiceErrorMessage(text: string): string {
    const value = parseJson(text);
    if (value === undefined) return text;
    if (isInvalidEncryptedContentError(value)) return INVALID_ENCRYPTED_CONTENT_MESSAGE;
    if (!isObject(value)
        || Object.keys(value).some(key => !["type", "status", "error"].includes(key))
        || value["type"] !== "error"
        || typeof value["status"] !== "number"
        || !Number.isInteger(value["status"])
        || value["status"] < 400 || value["status"] > 599
        || !isObject(value["error"])) return text;

    const error = value["error"];
    if (Object.keys(error).some(key => !["type", "message", "code", "param"].includes(key))
        || typeof error["type"] !== "string" || !SERVICE_ERROR_TYPES.has(error["type"])
        || typeof error["message"] !== "string" || error["message"].trim().length === 0
        || ["code", "param"].some(key => key in error && error[key] !== null && typeof error[key] !== "string")) return text;
    return error["message"];
}

/** A provider error `{error: {code}}`, or a gateway error that carries it in `metadata`. */
function isInvalidEncryptedContentError(value: unknown): boolean {
    if (!isObject(value) || !isObject(value["error"])) return false;
    const error = value["error"];
    if (error["code"] === INVALID_ENCRYPTED_CONTENT_CODE) return true;
    const metadata = error["metadata"];
    if (!isObject(metadata)) return false;
    return metadata["provider_error_code"] === INVALID_ENCRYPTED_CONTENT_CODE
        || typeof metadata["raw"] === "string" && isInvalidEncryptedContentError(parseJson(metadata["raw"]));
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
