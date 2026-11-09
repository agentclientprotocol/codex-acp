import type {JsonValue} from "../app-server/serde_json/JsonValue";

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordOrNull(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

export function normalizeJsonValue(value: unknown): JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return Number(value);
    if (Array.isArray(value)) return value.map(normalizeJsonValue);
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, nested]) => nested !== undefined)
                .map(([key, nested]) => [key, normalizeJsonValue(nested)]),
        );
    }
    return String(value);
}

export function normalizeJsonObject(value: Record<string, unknown>): Record<string, JsonValue> {
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .map(([key, nested]) => [key, normalizeJsonValue(nested)]),
    );
}
