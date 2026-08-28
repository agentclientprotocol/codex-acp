const MAX_RESPONSE_BYTES = 999;

export function toolResult(value: unknown): {content: Array<{type: "text", text: string}>} {
    return {content: [{type: "text", text: boundedJson(value)}]};
}

export function toolError(error: unknown): {content: Array<{type: "text", text: string}>, isError: true} {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{type: "text", text: truncate(message, Math.floor(MAX_RESPONSE_BYTES / 4))}],
        isError: true,
    };
}

export function truncate(text: string, limit: number): string {
    const characters = Array.from(text);
    if (characters.length <= limit) return text;
    return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function boundedJson(value: unknown): string {
    let current = value;
    let limit = Math.floor(MAX_RESPONSE_BYTES / 2);
    while (true) {
        const text = JSON.stringify(current);
        if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return text;
        if (limit === 0) throw new Error("Thread tool response exceeded the maximum context budget");
        current = truncateValue(current, limit);
        limit = Math.floor(limit / 2);
    }
}

function truncateValue(value: unknown, limit: number): unknown {
    if (typeof value === "string") return truncate(value, limit);
    if (Array.isArray(value)) return value.map(item => truncateValue(item, limit));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        isIdentityField(key) ? item : truncateValue(item, limit),
    ]));
}

function isIdentityField(name: string): boolean {
    return name === "id"
        || name.endsWith("Id")
        || name.endsWith("Ids")
        || name === "cursor"
        || name.endsWith("Cursor")
        || name === "type"
        || name === "status";
}
