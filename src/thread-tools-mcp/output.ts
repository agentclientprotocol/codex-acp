export const MAX_TOOL_RESPONSE_BYTES = 128 * 1024;

export const LOW_PRIORITY_RESPONSE_BYTES = 12 * 1024;

const MAX_ERROR_CHARS = 2_000;
const PAYLOAD_LIMITS = [16_384, 8_192, 4_096, 2_048, 1_024, 512, 256];
const LOW_PRIORITY_ITEM_TYPES = new Set([
    "reasoning",
    "hookPrompt",
    "contextCompaction",
    "sleep",
    "enteredReviewMode",
    "exitedReviewMode",
]);
const REMOVABLE_ITEM_TYPES = [
    "commandExecution",
    "fileChange",
    "functionCallOutput",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "imageGeneration",
];

export function toolResult(value: unknown): {content: Array<{type: "text", text: string}>} {
    return {content: [{type: "text", text: boundedJson(value)}]};
}

export function toolError(error: unknown): {content: Array<{type: "text", text: string}>, isError: true} {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{type: "text", text: truncate(message, MAX_ERROR_CHARS)}],
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
    const current = structuredClone(value);
    const original = JSON.stringify(current);
    if (Buffer.byteLength(original) <= LOW_PRIORITY_RESPONSE_BYTES) return original;

    if (removeLowPriorityItems(current) && isRecord(current)) current["truncated"] = true;
    const compacted = serializeWithinBudget(current);
    if (compacted !== null) return compacted;

    for (const limit of PAYLOAD_LIMITS) {
        truncateValue(current, limit);
        if (isRecord(current)) current["truncated"] = true;
        const text = serializeWithinBudget(current);
        if (text !== null) return text;
    }

    while (pruneResponse(current)) {
        if (isRecord(current)) current["truncated"] = true;
        const text = serializeWithinBudget(current);
        if (text !== null) return text;
    }

    throw new Error("Thread tool response exceeded the maximum context budget");
}

function serializeWithinBudget(value: unknown): string | null {
    const text = JSON.stringify(value);
    return Buffer.byteLength(text) <= MAX_TOOL_RESPONSE_BYTES ? text : null;
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
        if (pruneTurnItem(turns)) return true;
    }
    const threads = value["threads"];
    if (Array.isArray(threads) && threads.length > 1) {
        threads.pop();
        const omittedThreads = value["omittedThreads"];
        value["omittedThreads"] = typeof omittedThreads === "number" ? omittedThreads + 1 : 1;
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

function pruneTurnItem(turns: unknown[]): boolean {
    for (const type of REMOVABLE_ITEM_TYPES) {
        for (const turn of [...turns].reverse()) {
            if (!isRecord(turn) || !Array.isArray(turn["items"]) || turn["items"].length <= 1) continue;
            const index = turn["items"].findIndex(item => isRecord(item) && item["type"] === type);
            if (index < 0) continue;
            turn["items"].splice(index, 1);
            const omittedItems = turn["omittedItems"];
            turn["omittedItems"] = typeof omittedItems === "number" ? omittedItems + 1 : 1;
            return true;
        }
    }
    return false;
}

function removeLowPriorityItems(value: unknown): boolean {
    if (!isRecord(value) || !Array.isArray(value["turns"])) return false;
    let changed = false;
    for (const turn of value["turns"]) {
        if (!isRecord(turn) || !Array.isArray(turn["items"])) continue;
        const retainedItems = turn["items"].filter(item => !isRecord(item) || !LOW_PRIORITY_ITEM_TYPES.has(String(item["type"])));
        const omittedItems = turn["items"].length - retainedItems.length;
        if (omittedItems === 0) continue;
        turn["items"] = retainedItems;
        const previousCount = turn["omittedItems"];
        turn["omittedItems"] = (typeof previousCount === "number" ? previousCount : 0) + omittedItems;
        changed = true;
    }
    return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
