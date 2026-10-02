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

/** The maximum length of the raw error text that the cleanup reads. */
const MAX_INPUT_LENGTH = 2000;

/** An error chain segment that only wraps the real message. A JSON-RPC error code is also a wrapper. An HTTP status, such as `401`, stays. */
const WRAPPER_SEGMENT = /^(?:tool discovery failed|mcp startup failed|handshaking with mcp server failed|json-rpc error|startup error|error|mcp client for .+ failed to start|-32\d{3})$/i;

/**
 * A Rust type path with three or more parts, and the rest of its word, such as `[crate::module::Type<Inner>]`.
 * A short path, such as the Perl `Foo::Bar`, and an IPv6 address, such as `fe80::abcd`, stay.
 */
const TYPE_PATH = /\S*\w::\w+::\S*/g;

/**
 * Makes an MCP error chain short and readable, on one line.
 * It removes the wrapper segments and the Rust type paths.
 * It keeps at most two sentences and about 160 characters.
 * When nothing remains, it returns the shortened raw text.
 */
export function cleanErrorMessage(text: string): string {
    const oneLine = text.slice(0, MAX_INPUT_LENGTH).replace(/\s+/g, " ").trim();
    const message = oneLine.split(": ")
        .map(segment => segment.replace(TYPE_PATH, "").replace(/\s+/g, " ").trim())
        .filter(segment => segment.length > 0 && !WRAPPER_SEGMENT.test(segment))
        .join(": ");
    if (message.length === 0) {
        return shorten(oneLine);
    }
    return shorten(message.split(/(?<=[.!?])\s+/).slice(0, MAX_ERROR_SENTENCES).join(" "));
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
 * Each whitespace run becomes one space, so that a line break in the name cannot start a new markdown block.
 * A name that starts or ends with a backtick or a space gets a space on each side, so that the markdown keeps it as is.
 * An empty name shows as `(unnamed)`.
 */
export function inlineCode(name: string): string {
    const text = name.replace(/\s+/g, " ");
    if (text.length === 0) {
        return UNNAMED_SERVER;
    }
    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
    const fence = "`".repeat(longestRun + 1);
    const padding = /^[` ]|[` ]$/.test(text) ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
}
