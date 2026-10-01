import type {McpAuthStatus, McpServerConnectionStatus, McpServerStatus} from "../app-server/v2";

/** One MCP server in the status list. */
export type McpServerEntry = {
    name: string;
    status: McpServerConnectionStatus | null;
    toolCount: number | null;
    toolsError: string | null;
    authStatus: McpAuthStatus | null;
    /** False for a session MCP server that the Codex status list does not contain. */
    listedByCodex: boolean;
};

export const NO_SERVERS_MESSAGE = "No MCP servers are configured.";

/** The order of the counts in the summary line. */
const SUMMARY_ORDER: Array<McpServerConnectionStatus | null> = [
    "connected",
    "starting",
    "notStarted",
    "authenticationRequired",
    "failed",
    "cancelled",
    "disabled",
    null,
];

/** The order of the groups. The disabled servers come last, on one line. */
const GROUP_ORDER: Array<McpServerConnectionStatus | null> = [
    "failed",
    "cancelled",
    "authenticationRequired",
    "notStarted",
    "starting",
    "connected",
    null,
];

function statusLabel(status: McpServerConnectionStatus | null): string {
    switch (status) {
        case "connected":
            return "Connected";
        case "starting":
            return "Connecting";
        case "notStarted":
            return "Not started";
        case "authenticationRequired":
            return "Needs authentication";
        case "failed":
            return "Failed";
        case "cancelled":
            return "Cancelled";
        case "disabled":
            return "Disabled";
        case null:
            return "Unknown";
    }
}

/** The statuses that this adapter knows. */
const KNOWN_STATUSES = new Set<McpServerConnectionStatus>([...GROUP_ORDER.filter((status): status is McpServerConnectionStatus => status !== null), "disabled"]);

/** A status that a newer Codex reports and this adapter does not know becomes `null`, so that the list shows it as unknown. */
export function toEntry(server: McpServerStatus): McpServerEntry {
    const status = server.runtimeStatus;
    return {
        name: server.name,
        status: status !== null && KNOWN_STATUSES.has(status) ? status : null,
        toolCount: Object.keys(server.tools ?? {}).length,
        toolsError: server.toolsError,
        authStatus: server.authStatus,
        listedByCodex: true,
    };
}

/**
 * Formats the servers as a markdown list, grouped by the status.
 * `errors` maps a server name to its startup error.
 * Inside a group, the servers keep the Codex order.
 */
export function formatStatus(servers: McpServerEntry[], errors: Map<string, string>): string {
    if (servers.length === 0) {
        return NO_SERVERS_MESSAGE;
    }
    const counts = SUMMARY_ORDER
        .map(status => ({status, count: servers.filter(server => server.status === status).length}))
        .filter(entry => entry.count > 0)
        .map(entry => `${entry.count} ${statusLabel(entry.status).toLowerCase()}`);
    const lines = [`**MCP servers:** ${servers.length} (${counts.join(", ")})`];
    for (const status of GROUP_ORDER) {
        const group = servers.filter(server => server.status === status);
        if (group.length === 0) {
            continue;
        }
        lines.push("", `**${statusLabel(status)}**`);
        for (const server of group) {
            const detail = serverDetail(server, errors.get(server.name) ?? null);
            lines.push(detail === null ? `- ${inlineCode(server.name)}` : `- ${inlineCode(server.name)}: ${detail}`);
        }
    }
    const disabled = servers.filter(server => server.status === "disabled");
    if (disabled.length > 0) {
        lines.push("", `**Disabled:** ${disabled.map(server => inlineCode(server.name)).join(", ")}`);
    }
    if (servers.some(server => server.status !== null && RECONNECT_HINT_STATUSES.has(server.status))) {
        lines.push("", RECONNECT_HINT);
    }
    return lines.join("\n");
}

export const RECONNECT_HINT = "Run `/mcp reconnect` to restart the servers that are not connected.";

/** The statuses that a reconnect can change. */
const RECONNECT_HINT_STATUSES = new Set<McpServerConnectionStatus>(["failed", "cancelled", "authenticationRequired", "notStarted"]);

function serverDetail(server: McpServerEntry, startupError: string | null): string | null {
    if (server.status === "authenticationRequired") {
        return NOT_SIGNED_IN;
    }
    const parts: string[] = [];
    const toolCount = server.toolCount ?? 0;
    if (server.status === "connected" || toolCount > 0) {
        parts.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
    }
    if (server.authStatus === "notLoggedIn" && server.status !== "disabled") {
        parts.push(NOT_SIGNED_IN);
    }
    const error = startupError ?? server.toolsError;
    const cleanedError = error === null ? "" : formatNoteDetail(error);
    if (cleanedError.length > 0) {
        parts.push(cleanedError);
    }
    return parts.length === 0 ? null : parts.join("; ");
}

const NOT_SIGNED_IN = "not signed in";

/** The maximum length of a cleaned error, without the ellipsis. */
const MAX_ERROR_LENGTH = 160;

const MAX_ERROR_SENTENCES = 2;

/** The error chain segments that only wrap the real message. */
const WRAPPER_SEGMENTS = [
    /^tool discovery failed$/i,
    /^mcp startup failed$/i,
    /^handshaking with mcp server failed$/i,
    /^json-rpc error$/i,
    /^startup error$/i,
    /^error$/i,
    /^mcp client for .+ failed to start$/i,
    /^-?\d+$/,
];

/**
 * Finds a Rust type path, such as `crate::module::Type`, with an optional `Transport [` prefix.
 * The lookbehind skips an IPv6 address, such as `[::1]` or `[fe80::1]`, and a URL.
 */
const TYPE_PATH = /(?:\b[A-Z]\w*\s*\[\s*|(?<![\w[:./-]))[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+/g;

/** Splits the text after a sentence end, but not after `e.g.` or `i.e.`. */
const SENTENCE_END = /(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s+/i;

/**
 * Removes the Rust type paths and their generic arguments.
 * When the generic arguments have no end, because Codex shortened the text, it removes the rest of the segment.
 */
function removeTypePaths(segment: string): string {
    let result = "";
    let position = 0;
    TYPE_PATH.lastIndex = 0;
    for (let match = TYPE_PATH.exec(segment); match !== null; match = TYPE_PATH.exec(segment)) {
        result += segment.slice(position, match.index);
        let end = match.index + match[0].length;
        if (segment[end] === "<") {
            end = genericsEnd(segment, end);
            if (end < 0) {
                return result.trim();
            }
        }
        if (match[0].includes("[")) {
            const bracket = /^\s*]/.exec(segment.slice(end));
            end += bracket === null ? 0 : bracket[0].length;
        }
        position = end;
        TYPE_PATH.lastIndex = end;
    }
    return (result + segment.slice(position)).replace(/\s+/g, " ").trim();
}

/** Returns the index after the `>` that closes the `<` at `start`, or -1 when the text has no such `>`. */
function genericsEnd(text: string, start: number): number {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        if (text[index] === "<") {
            depth++;
        } else if (text[index] === ">") {
            depth--;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    return -1;
}

/**
 * Makes an MCP error chain short and readable, on one line.
 * It removes the wrapper segments, the numeric codes, the Rust type paths, and the repeated messages.
 * It keeps at most two sentences and about 160 characters.
 * When nothing remains, it returns the shortened raw text.
 */
export function cleanErrorMessage(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    const kept: string[] = [];
    for (const rawSegment of oneLine.split(": ")) {
        const segment = removeTypePaths(rawSegment.trim());
        if (segment.length === 0 || WRAPPER_SEGMENTS.some(pattern => pattern.test(segment))) {
            continue;
        }
        const withoutEllipsis = withoutTrailingEllipsis(segment);
        if (kept.some(previous => previous.startsWith(withoutEllipsis))) {
            continue;
        }
        // A segment that repeats an earlier one and adds more text replaces it, such as `timeout: timeout after 30s`.
        const repeated = kept.findIndex(previous => startsWithWords(segment, withoutTrailingEllipsis(previous)));
        if (repeated >= 0) {
            kept.splice(repeated, 1);
        }
        kept.push(segment);
    }
    if (kept.length === 0) {
        return shorten(oneLine);
    }
    const sentences = kept.join(": ").split(SENTENCE_END);
    return shorten(sentences.slice(0, MAX_ERROR_SENTENCES).join(" "));
}

function withoutTrailingEllipsis(text: string): string {
    return text.replace(/(?:\.\.\.|…)$/, "").trim();
}

/** True when `text` starts with `prefix` and the prefix ends at a word end. */
function startsWithWords(text: string, prefix: string): boolean {
    return prefix.length > 0 && text.startsWith(prefix) && (text.length === prefix.length || /\W/.test(text[prefix.length]!));
}

/** Shortens the text by code points, so that the cut never splits a surrogate pair. */
function shorten(text: string): string {
    const codePoints = Array.from(text);
    return codePoints.length > MAX_ERROR_LENGTH ? `${codePoints.slice(0, MAX_ERROR_LENGTH).join("").trimEnd()}…` : text;
}

/** Cleans an error text and escapes the markdown characters, so that it is safe in a list item or a note. */
export function formatNoteDetail(text: string): string {
    return escapeMarkdown(cleanErrorMessage(text));
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_[\]<>~]/g, character => `\\${character}`);
}

export const UNNAMED_SERVER = "(unnamed)";

/**
 * Formats a server name as inline code. The fence is one backtick longer than the longest backtick run in the name.
 * A name that starts or ends with a backtick or a space gets a space on each side, so that the markdown keeps it as is.
 * An empty name shows as `(unnamed)`.
 */
export function inlineCode(text: string): string {
    if (text.length === 0) {
        return UNNAMED_SERVER;
    }
    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
    const fence = "`".repeat(longestRun + 1);
    const padding = /^[` ]|[` ]$/.test(text) ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
}
