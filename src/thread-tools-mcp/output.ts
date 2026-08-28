const MAX_RESPONSE_BYTES = 999;

export function toolResult(value: unknown): {content: Array<{type: "text", text: string}>} {
    return {content: [{type: "text", text: boundedJson(value)}]};
}

export function toolError(error: unknown): {content: Array<{type: "text", text: string}>, isError: true} {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{type: "text", text: truncate(message, Math.floor(MAX_RESPONSE_BYTES / 4) - 1)}],
        isError: true,
    };
}

export function truncate(text: string, limit: number): string {
    const characters = Array.from(text);
    if (characters.length <= limit) return text;
    if (limit === 0) return "";
    return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function boundedJson(value: unknown): string {
    let current = structuredClone(value);
    let limit = Math.floor(MAX_RESPONSE_BYTES / 2);
    while (true) {
        const text = JSON.stringify(current);
        if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) return text;
        if (limit === 0) {
            if (pruneResponse(current)) continue;
            throw new Error("Thread tool response exceeded the maximum context budget");
        }
        limit = Math.floor(limit / 2);
        truncateValue(current, limit);
        if (isRecord(current)) current["truncated"] = true;
    }
}

function truncateValue(value: unknown, limit: number): void {
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            if (typeof item === "string") value[index] = truncate(item, limit);
            else truncateValue(item, limit);
        });
        return;
    }
    if (!isRecord(value)) return;
    const text = value["text"];
    if (typeof text === "string" && Array.from(text).length > limit && typeof value["truncated"] === "boolean") {
        value["truncated"] = true;
        value["originalChars"] ??= Array.from(text).length;
    }
    Object.entries(value).forEach(([name, item]) => {
        if (isIdentityField(name)) return;
        if (typeof item === "string") value[name] = truncate(item, limit);
        else truncateValue(item, limit);
    });
}

function isIdentityField(name: string): boolean {
    return name === "id"
        || name.endsWith("Id")
        || name.endsWith("Ids")
        || name === "cursor"
        || name.endsWith("Cursor")
        || name.endsWith("Status")
        || name === "type"
        || name === "status"
        || name === "kind"
        || name === "reason"
        || name === "namespace"
        || name === "tool"
        || name === "server";
}

function pruneResponse(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const turns = value["turns"];
    if (Array.isArray(turns)) {
        const turn = [...turns].reverse().find(item => isRecord(item) && Array.isArray(item["items"]) && item["items"].length > 0);
        if (isRecord(turn) && Array.isArray(turn["items"])) {
            turn["items"].shift();
            return true;
        }
    }
    const threads = value["threads"];
    if (Array.isArray(threads) && threads.length > 1) {
        threads.pop();
        return true;
    }
    const polls = value["polls"];
    if (Array.isArray(polls)) {
        const removable = [
            "latestAssistantMessage",
            "latestToolMarker",
            "latestTurn",
            "latestAssistantMessageId",
            "latestToolMarkerId",
            "revision",
            "schemaVersion",
            "changed",
            "cursor",
        ];
        for (const poll of [...polls].reverse()) {
            if (!isRecord(poll)) continue;
            const name = removable.find(field => field in poll);
            if (name !== undefined) {
                delete poll[name];
                return true;
            }
        }
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
