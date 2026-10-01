import {describe, expect, it} from "vitest";
import type {McpServerStatus} from "../app-server/v2";
import {cleanErrorMessage, formatStatus, inlineCode, type McpServerEntry, toEntry} from "../mcp/McpStatusMarkdown";

const GLEAN_ERROR = "Tool discovery failed: MCP startup failed: handshaking with MCP server failed: Send message error Transport "
    + "[codex_rmcp_client::event_notification_transport::EventNotificationTransport<rmcp::transport::worker::WorkerTransport<"
    + "rmcp::transport::streamable_http_client::StreamableHttpClientWorker<codex_rmcp_client::http_clien...; Auth: not logged in";

const IJPROXY_ERROR = "Tool discovery failed: MCP startup failed: handshaking with MCP server failed: JSON-RPC error: -32603: "
    + "No IDE found. Install the \"MCP Server\" plugin and ensure it is enabled. Probed ports: 64342, 64344 + scan 64342..64351: "
    + "JSON-RPC error: -32603: No IDE found. Install the \"MCP Server\" plugin and ensure it is enabled. Prob...";

function entry(overrides: Partial<McpServerEntry> & {name: string}): McpServerEntry {
    return {
        status: "connected",
        toolCount: 0,
        toolsError: null,
        authStatus: "unsupported",
        listedByCodex: true,
        ...overrides,
    };
}

describe("cleanErrorMessage", () => {
    it("keeps the human message of the ijproxy error", () => {
        expect(cleanErrorMessage(IJPROXY_ERROR)).toBe("No IDE found. Install the \"MCP Server\" plugin and ensure it is enabled.");
    });

    it("removes the wrappers and the Rust type paths of the Glean error", () => {
        expect(cleanErrorMessage(GLEAN_ERROR)).toBe("Send message error: not logged in");
    });

    it("keeps the cause after a message that is not a wrapper", () => {
        expect(cleanErrorMessage("failed to refresh MCP servers: invalid config.toml")).toBe("failed to refresh MCP servers: invalid config.toml");
    });

    it("removes the MCP client wrapper of a startup error", () => {
        expect(cleanErrorMessage("MCP client for `fs` failed to start: spawn ENOENT")).toBe("spawn ENOENT");
    });

    it("puts the text on one line and shortens it with an ellipsis", () => {
        expect(cleanErrorMessage(`first\nsecond ${"x".repeat(300)}`)).toBe(`first second ${"x".repeat(160 - "first second ".length)}…`);
    });

    it("returns the shortened raw text when only wrappers remain", () => {
        expect(cleanErrorMessage("JSON-RPC error: -32603")).toBe("JSON-RPC error: -32603");
    });

    it("keeps a lone less-than sign", () => {
        expect(cleanErrorMessage("expected value < 10, got 12")).toBe("expected value < 10, got 12");
    });

    it("keeps a generic type without a type path", () => {
        expect(cleanErrorMessage("invalid header: Header value contains Vec<u8> bytes"))
            .toBe("invalid header: Header value contains Vec<u8> bytes");
    });

    it("keeps an IPv6 URL", () => {
        expect(cleanErrorMessage("failed to connect to http://[::1]:8080/mcp: Connection refused"))
            .toBe("failed to connect to http://[::1]:8080/mcp: Connection refused");
        expect(cleanErrorMessage("failed to connect to http://[fe80::1]:8080/mcp")).toBe("failed to connect to http://[fe80::1]:8080/mcp");
    });

    it("removes a closed type path and keeps the text after it", () => {
        expect(cleanErrorMessage("expected std::vec::Vec<u8> here, got a string")).toBe("expected here, got a string");
        expect(cleanErrorMessage("send failed Transport [rmcp::Transport<A<B>>] now")).toBe("send failed now");
    });

    it("returns an empty text for an empty error", () => {
        expect(cleanErrorMessage("")).toBe("");
        expect(cleanErrorMessage("  \n ")).toBe("");
    });

    it("shortens by code points and never splits a surrogate pair", () => {
        const text = `${"x".repeat(159)}😀😀`;

        expect(cleanErrorMessage(text)).toBe(`${"x".repeat(159)}😀…`);
    });

    it("drops an earlier segment that the next segment repeats and extends", () => {
        expect(cleanErrorMessage("timeout: timeout after 30s")).toBe("timeout after 30s");
        expect(cleanErrorMessage("time: timeout after 30s")).toBe("time: timeout after 30s");
    });

    it("does not end a sentence at e.g. or i.e.", () => {
        expect(cleanErrorMessage("Bad flag, e.g. --foo is unknown. Use i.e. the default. Third sentence."))
            .toBe("Bad flag, e.g. --foo is unknown. Use i.e. the default.");
    });
});

describe("formatStatus", () => {
    it("groups the servers of a real session", () => {
        const servers = [
            entry({name: "code-review", status: "disabled"}),
            entry({name: "codex_app", status: "disabled"}),
            entry({name: "codex_apps", toolCount: 100, authStatus: "bearerToken"}),
            entry({name: "computer-use", status: "disabled"}),
            entry({name: "cua_repl", toolCount: 3}),
            entry({
                name: "Glean",
                status: "authenticationRequired",
                authStatus: "notLoggedIn",
                toolsError: GLEAN_ERROR.replace("; Auth: not logged in", ""),
            }),
            entry({name: "ijproxy", status: "failed", toolsError: IJPROXY_ERROR}),
            entry({name: "jbcontext", toolCount: 1}),
            entry({name: "node_repl", toolCount: 4}),
            entry({name: "openaiDeveloperDocs", toolCount: 5}),
        ];

        expect(formatStatus(servers, new Map())).toBe([
            "**MCP servers:** 10 (5 connected, 1 needs authentication, 1 failed, 3 disabled)",
            "",
            "**Failed**",
            "- `ijproxy`: No IDE found. Install the \"MCP Server\" plugin and ensure it is enabled.",
            "",
            "**Needs authentication**",
            "- `Glean`: not signed in",
            "",
            "**Connected**",
            "- `codex_apps`: 100 tools",
            "- `cua_repl`: 3 tools",
            "- `jbcontext`: 1 tool",
            "- `node_repl`: 4 tools",
            "- `openaiDeveloperDocs`: 5 tools",
            "",
            "**Disabled:** `code-review`, `codex_app`, `computer-use`",
            "",
            "Run `/mcp reconnect` to restart the servers that are not connected.",
        ].join("\n"));
    });

    it("orders the groups and omits the empty ones", () => {
        const servers = [
            entry({name: "unknown", status: null}),
            entry({name: "up"}),
            entry({name: "slow", status: "starting"}),
            entry({name: "idle", status: "notStarted"}),
            entry({name: "stopped", status: "cancelled"}),
            entry({name: "broken", status: "failed"}),
        ];

        const headers = formatStatus(servers, new Map()).split("\n").filter(line => /^\*\*[^:]+\*\*$/.test(line));

        expect(headers).toEqual(["**Failed**", "**Cancelled**", "**Not started**", "**Connecting**", "**Connected**", "**Unknown**"]);
    });

    it("shows the tool count of a connected server in the singular and the plural", () => {
        const text = formatStatus([entry({name: "none"}), entry({name: "one", toolCount: 1}), entry({name: "two", toolCount: 2})], new Map());

        expect(text).toContain("- `none`: 0 tools\n- `one`: 1 tool\n- `two`: 2 tools");
    });

    it("shows the tool count of a server that is not connected only when it has tools", () => {
        const text = formatStatus([
            entry({name: "empty", status: "starting"}),
            entry({name: "cached", status: "starting", toolCount: 2}),
        ], new Map());

        expect(text).toContain("- `empty`\n- `cached`: 2 tools");
    });

    it("prefers the startup error to the tool discovery error, and escapes the markdown", () => {
        const text = formatStatus(
            [entry({name: "fs", status: "failed", toolsError: "old error"})],
            new Map([["fs", "MCP client for `fs` failed to start: bad *glob* in [args]"]]),
        );

        expect(text).toContain("- `fs`: bad \\*glob\\* in \\[args\\]");
    });

    it("puts the disabled servers on one line and shows no reconnect hint for them", () => {
        const text = formatStatus([entry({name: "a", status: "disabled"}), entry({name: "b`c", status: "disabled"})], new Map());

        expect(text).toBe("**MCP servers:** 2 (2 disabled)\n\n**Disabled:** `a`, ``b`c``");
    });

    it("keeps the session servers that Codex does not list in the unknown group", () => {
        const text = formatStatus([
            entry({name: "fs", status: null, toolCount: 1}),
            entry({name: "client-mcp", status: null, toolCount: null, authStatus: null, listedByCodex: false}),
        ], new Map());

        expect(text).toBe("**MCP servers:** 2 (2 unknown)\n\n**Unknown**\n- `fs`: 1 tool\n- `client-mcp`");
    });

    it("shows no dangling colon for an empty error", () => {
        const text = formatStatus([
            entry({name: "a", status: "failed", toolsError: ""}),
            entry({name: "b", status: "failed", toolsError: "   "}),
        ], new Map());

        expect(text).toContain("**Failed**\n- `a`\n- `b`\n");
    });

    it("shows not signed in for a server that is not logged in and has another status", () => {
        const text = formatStatus([
            entry({name: "browser", status: null, authStatus: "notLoggedIn"}),
            entry({name: "docs", toolCount: 2, authStatus: "notLoggedIn"}),
            entry({name: "off", status: "disabled", authStatus: "notLoggedIn"}),
        ], new Map());

        expect(text).toContain("- `docs`: 2 tools; not signed in");
        expect(text).toContain("**Unknown**\n- `browser`: not signed in");
        expect(text).toContain("**Disabled:** `off`");
    });

    it("shows a status that this adapter does not know as unknown", () => {
        const server = {name: "future", runtimeStatus: "hibernating", tools: {}, toolsError: null, authStatus: "unsupported"} as unknown as McpServerStatus;

        expect(toEntry(server).status).toBeNull();
        expect(formatStatus([toEntry(server)], new Map())).toBe("**MCP servers:** 1 (1 unknown)\n\n**Unknown**\n- `future`");
    });
});

describe("inlineCode", () => {
    it("uses a fence that is longer than the backtick runs of the name", () => {
        expect(inlineCode("plain")).toBe("`plain`");
        expect(inlineCode("a``b")).toBe("```a``b```");
    });

    it("pads a name that starts or ends with a backtick", () => {
        expect(inlineCode("`a")).toBe("`` `a ``");
        expect(inlineCode("a`")).toBe("`` a` ``");
    });

    it("shows an empty name as unnamed", () => {
        expect(inlineCode("")).toBe("(unnamed)");
    });
});
