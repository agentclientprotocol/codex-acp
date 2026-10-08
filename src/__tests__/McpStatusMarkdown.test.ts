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
        expect(cleanErrorMessage(GLEAN_ERROR)).toBe("Send message error Transport Auth: not logged in");
        expect(cleanErrorMessage("expected std::vec::Vec<u8> here, got a string")).toBe("expected here, got a string");
    });

    it("keeps the cause after a message that is not a wrapper", () => {
        expect(cleanErrorMessage("failed to refresh MCP servers: invalid config.toml")).toBe("failed to refresh MCP servers: invalid config.toml");
        expect(cleanErrorMessage("MCP client for `fs` failed to start: spawn ENOENT")).toBe("spawn ENOENT");
    });

    it("keeps an HTTP status and removes a JSON-RPC code", () => {
        expect(cleanErrorMessage("server returned status: 401")).toBe("server returned status: 401");
        expect(cleanErrorMessage("request failed: -32601: Method not found")).toBe("request failed: Method not found");
    });

    it("keeps the text that is not a Rust type path", () => {
        for (const text of [
            "expected value < 10, got 12",
            "invalid header: Header value contains Vec<u8> bytes",
            "failed to connect to http://[::1]:8080/mcp: Connection refused",
            "connect to fe80::abcd failed",
            "Can't locate Foo::Bar in @INC",
        ]) {
            expect(cleanErrorMessage(text)).toBe(text);
        }
    });

    it("returns the raw text when only wrappers remain, and an empty text for an empty error", () => {
        expect(cleanErrorMessage("JSON-RPC error: -32603")).toBe("JSON-RPC error: -32603");
        expect(cleanErrorMessage("  \n ")).toBe("");
    });

    it("keeps two sentences on one line and shortens the text by code points", () => {
        expect(cleanErrorMessage("First one.\nSecond one! Third one.")).toBe("First one. Second one!");
        expect(cleanErrorMessage(`${"x".repeat(159)}😀😀`)).toBe(`${"x".repeat(159)}😀…`);
    });

    it("cleans a long error fast", () => {
        const text = Array.from({length: 20000}, (_, index) => `part ${index} x`).join(": ");
        const start = performance.now();

        const cleaned = cleanErrorMessage(text);

        expect(performance.now() - start).toBeLessThan(500);
        expect(cleaned.startsWith("part 0 x: part 1 x")).toBe(true);
        expect(cleaned.endsWith("…")).toBe(true);
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

    it("puts a name with a line break on one line", () => {
        expect(inlineCode("a\n# H")).toBe("`a # H`");
        expect(formatStatus([entry({name: "a\n# H", status: null})], new Map())).toContain("\n- `a # H`");
    });
});
