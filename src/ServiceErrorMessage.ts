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

/** Reads the message of a known service error envelope. Other text stays unchanged. */
export function readableServiceErrorMessage(text: string): string {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return text;
    }
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

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
