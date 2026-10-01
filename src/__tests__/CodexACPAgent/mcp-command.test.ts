import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {type CodexMockTestFixture, setupPromptTestSession} from "../acp-test-utils";
import type {
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    McpServerStartupState,
    McpServerStatus,
} from "../../app-server/v2";
import {MCP_RECONNECT_STARTUP_TIMEOUT_MS} from "../../mcp/McpCommand";

const sessionId = "session-id";

function server(overrides: Partial<McpServerStatus> & {name: string}): McpServerStatus {
    return {
        runtimeStatus: "connected",
        pluginId: null,
        httpOrigin: null,
        serverInfo: null,
        serverCapabilities: null,
        tools: {},
        toolsError: null,
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
        ...overrides,
    };
}

function tools(...names: string[]): McpServerStatus["tools"] {
    return Object.fromEntries(names.map(name => [name, {name, inputSchema: {type: "object"}}]));
}

function startupStatus(
    name: string,
    status: McpServerStartupState,
    error: string | null = null,
    failureReason: "reauthenticationRequired" | null = null,
    threadId: string | null = sessionId,
) {
    return {
        method: "mcpServer/startupStatus/updated",
        params: {threadId, name, status, error, failureReason},
    };
}

async function enableUrlElicitation(fixture: CodexMockTestFixture): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {elicitation: {url: {}}},
    });
}

function mockOauthLogin(fixture: CodexMockTestFixture, success = true) {
    const codexAcpClient = fixture.getCodexAcpClient();
    vi.spyOn(codexAcpClient, "awaitMcpServerOauthLoginCompleted").mockResolvedValue({
        name: "linear",
        threadId: sessionId,
        success,
    });
    return vi.spyOn(codexAcpClient, "mcpServerOauthLogin").mockResolvedValue({
        authorizationUrl: "https://example.com/oauth/authorize",
    });
}

function pendingStartupWaits(fixture: CodexMockTestFixture): number {
    return (fixture.getCodexAppServerClient().mcpStartup as unknown as {waiters: unknown[]}).waiters.length;
}

function pendingOauthWaits(fixture: CodexMockTestFixture): number {
    const waiters = (fixture.getCodexAppServerClient().mcpOauthCompletions as unknown as {waiters: Map<string, Set<unknown>>}).waiters;
    return [...waiters.values()].reduce((count, set) => count + set.size, 0);
}

function elicitationEvents(fixture: CodexMockTestFixture, method: "createElicitation" | "completeElicitation") {
    return fixture.getAcpConnectionEvents([]).filter(event => event.method === method);
}

function messageText(fixture: CodexMockTestFixture): string {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate" && event.args[0].update.sessionUpdate === "agent_message_chunk")
        .map(event => event.args[0].update.content.text)
        .join("");
}

function mockStatusPages(fixture: CodexMockTestFixture, ...pages: ListMcpServerStatusResponse[]) {
    const appServer = fixture.getCodexAppServerClient();
    let index = 0;
    return vi.spyOn(appServer, "listMcpServerStatus").mockImplementation(async () => {
        const page = pages[Math.min(index, pages.length - 1)]!;
        index += 1;
        return page;
    });
}

async function runMcp(fixture: CodexMockTestFixture, text: string): Promise<void> {
    fixture.clearAcpConnectionDump();
    await fixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text}]});
}

describe("/mcp command", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("lists the live status of the thread's MCP servers, grouped by the status", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const list = mockStatusPages(mockFixture, {
            data: [
                server({name: "fs", tools: tools("listFiles", "readFile"), authStatus: "bearerToken"}),
                server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"}),
                server({name: "broken", runtimeStatus: "failed", toolsError: "spawn ENOENT | exit 1"}),
                server({name: "slow", runtimeStatus: "starting"}),
                server({name: "off", runtimeStatus: "disabled"}),
                server({name: "legacy", runtimeStatus: null}),
            ],
            nextCursor: null,
        });

        await runMcp(mockFixture, "/mcp");

        expect(list).toHaveBeenCalledWith({cursor: null, detail: "toolsAndAuthOnly", threadId: sessionId});
        await expect(messageText(mockFixture)).toMatchFileSnapshot("data/mcp-command-status.md");
    });

    it("reads every page of the MCP server status list", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const list = mockStatusPages(mockFixture,
            {data: [server({name: "first", tools: tools("a")})], nextCursor: "page-2"},
            {data: [server({name: "second", runtimeStatus: "notStarted"})], nextCursor: "page-3"},
            {data: [server({name: "third", runtimeStatus: "cancelled"})], nextCursor: null},
        );

        await runMcp(mockFixture, "/mcp");

        expect(list.mock.calls.map(call => (call[0] as ListMcpServerStatusParams).cursor)).toEqual([null, "page-2", "page-3"]);
        await expect(messageText(mockFixture)).toMatchFileSnapshot("data/mcp-command-pages.md");
    });

    it("shortens a long error in the list", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {
            data: [server({name: "broken", runtimeStatus: "failed", toolsError: `${"x".repeat(400)}\nsecond line`})],
            nextCursor: null,
        });

        await runMcp(mockFixture, "/mcp");

        expect(messageText(mockFixture)).toContain(`- \`broken\`: ${"x".repeat(160)}…\n`);
    });

    it("says that no MCP servers are configured", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [], nextCursor: null});

        await runMcp(mockFixture, "/mcp");

        expect(messageText(mockFixture)).toBe("No MCP servers are configured.");
    });

    it("adds the session MCP servers that the status list does not contain", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId, sessionMcpServers: ["fs", "client-mcp"]});
        mockStatusPages(mockFixture, {data: [server({name: "fs", tools: tools("a")})], nextCursor: null});

        await runMcp(mockFixture, "/mcp");

        const text = messageText(mockFixture);
        expect(text).toContain("**Connected**\n- `fs`: 1 tool");
        expect(text).toContain("**Unknown**\n- `client-mcp`");
    });

    it("rejects an unknown subcommand", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const list = mockStatusPages(mockFixture, {data: [], nextCursor: null});

        await runMcp(mockFixture, "/mcp restart");

        expect(list).not.toHaveBeenCalled();
        expect(messageText(mockFixture)).toBe('Command "/mcp" accepts no arguments, or `reconnect [server]`.');
    });

    it("reloads the MCP configuration, waits for the startup, and shows the new status", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture,
            {data: [server({name: "fs", runtimeStatus: "failed"}), server({name: "docs", tools: tools("search")})], nextCursor: null},
            {data: [server({name: "fs", tools: tools("listFiles")}), server({name: "docs", tools: tools("search")})], nextCursor: null},
        );
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "starting"));
            mockFixture.sendServerNotification(startupStatus("fs", "ready"));
            mockFixture.sendServerNotification(startupStatus("docs", "ready"));
            return {};
        });

        await runMcp(mockFixture, "/mcp reconnect");

        expect(reload).toHaveBeenCalledTimes(1);
        await expect(messageText(mockFixture)).toMatchFileSnapshot("data/mcp-command-reconnect.md");
    });

    it("shows the startup error of a server that fails again after the reload", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "failed"})], nextCursor: null});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "failed", "MCP client for `fs` failed to start: spawn ENOENT"));
            return {};
        });

        await runMcp(mockFixture, "/mcp reconnect");

        expect(messageText(mockFixture)).toContain("**Failed**\n- `fs`: spawn ENOENT");
    });

    it("explains that a reconnect of one server reloads all MCP servers", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs"}), server({name: "docs"})], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "ready"));
            mockFixture.sendServerNotification(startupStatus("docs", "ready"));
            return {};
        });

        await runMcp(mockFixture, "/mcp reconnect fs");

        expect(reload).toHaveBeenCalledTimes(1);
        expect(messageText(mockFixture)).toContain(
            "Codex cannot reconnect a single server. The reload applies to all MCP servers, not only `fs`.",
        );
    });

    it("rejects an unknown server name and lists the known servers", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs"}), server({name: "docs"})], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload");

        await runMcp(mockFixture, "/mcp reconnect github");

        expect(reload).not.toHaveBeenCalled();
        expect(messageText(mockFixture)).toBe("Unknown MCP server `github`. Known servers: `fs`, `docs`.");
    });

    it("does not reload when no MCP servers are configured", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload");

        await runMcp(mockFixture, "/mcp reconnect");

        expect(reload).not.toHaveBeenCalled();
        expect(messageText(mockFixture)).toBe("No MCP servers are configured.");
    });

    it("reports a reload error and still shows the current status", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "failed"})], nextCursor: null});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload")
            .mockRejectedValue(new Error("failed to refresh MCP servers: invalid config.toml"));

        await runMcp(mockFixture, "/mcp reconnect");

        await expect(messageText(mockFixture)).toMatchFileSnapshot("data/mcp-command-reload-error.md");
    });

    it("stops the wait for the startup after the timeout", async () => {
        vi.useFakeTimers();
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "slow", runtimeStatus: "starting"})], nextCursor: null});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockResolvedValue({});

        mockFixture.clearAcpConnectionDump();
        const prompt = mockFixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/mcp reconnect"}]});
        await vi.advanceTimersByTimeAsync(MCP_RECONNECT_STARTUP_TIMEOUT_MS);
        await prompt;

        expect(messageText(mockFixture)).toContain("Some MCP servers are still starting. Run `/mcp` again later to see their status.");
        expect(messageText(mockFixture)).toContain("**Connecting**\n- `slow`");
        expect(pendingStartupWaits(mockFixture)).toBe(0);
    });

    it("signs in to a server that needs authentication when the client supports URL elicitation", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        await enableUrlElicitation(mockFixture);
        mockFixture.setElicitationResponse({action: "accept"});
        const needsAuth = {data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})], nextCursor: null};
        mockStatusPages(mockFixture,
            needsAuth,
            needsAuth,
            needsAuth,
            {data: [server({name: "linear", tools: tools("issues"), authStatus: "oAuth"})], nextCursor: null},
        );
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(reload.mock.calls.length === 1
                ? startupStatus("linear", "failed", "OAuth token expired", "reauthenticationRequired")
                : startupStatus("linear", "ready"));
            return {};
        });
        const login = mockOauthLogin(mockFixture);

        await runMcp(mockFixture, "/mcp reconnect");

        expect(login).toHaveBeenCalledWith({name: "linear", threadId: sessionId});
        expect(reload).toHaveBeenCalledTimes(2);
        const text = messageText(mockFixture);
        expect(text).toContain("Signed in to MCP server `linear`.");
        expect(text).toContain("**Connected**\n- `linear`: 1 tool");
    });

    it("says that the client cannot sign in without URL elicitation", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {
            data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})],
            nextCursor: null,
        });
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("linear", "failed", "OAuth token expired", "reauthenticationRequired"));
            return {};
        });
        const login = vi.spyOn(mockFixture.getCodexAcpClient(), "mcpServerOauthLogin");

        await runMcp(mockFixture, "/mcp reconnect");

        expect(login).not.toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(messageText(mockFixture)).toContain(
            "MCP server `linear` needs authentication, but this client cannot open a sign-in page.",
        );
    });

    it("does not sign in when the reload fails", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        await enableUrlElicitation(mockFixture);
        mockStatusPages(mockFixture, {
            data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})],
            nextCursor: null,
        });
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload")
            .mockRejectedValue(new Error("invalid config.toml"));
        const login = mockOauthLogin(mockFixture);

        await runMcp(mockFixture, "/mcp reconnect");

        expect(login).not.toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(messageText(mockFixture)).toContain("Could not reload the MCP configuration: invalid config.toml");
    });

    it("puts a reload error on one line, escapes the markdown, and shortens it", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "failed"})], nextCursor: null});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload")
            .mockRejectedValue(new Error(`bad \`fs\` entry\n${"y".repeat(400)}`));

        await runMcp(mockFixture, "/mcp reconnect");

        const [label, firstNote] = messageText(mockFixture).split("\n");
        expect(label).toBe("**Reconnect:**");
        expect(firstNote).toBe(`- Could not reload the MCP configuration: bad \\\`fs\\\` entry ${"y".repeat(160 - "bad `fs` entry ".length)}…`);
    });

    it.each([
        ["declines the sign-in", (fixture: CodexMockTestFixture) => {
            fixture.setElicitationResponse({action: "decline"});
            mockOauthLogin(fixture);
            vi.spyOn(fixture.getCodexAcpClient(), "awaitMcpServerOauthLoginCompleted").mockReturnValue(new Promise(() => {}));
        }],
        ["the sign-in fails", (fixture: CodexMockTestFixture) => {
            fixture.setElicitationResponse({action: "accept"});
            mockOauthLogin(fixture, false);
        }],
        ["the sign-in throws", (fixture: CodexMockTestFixture) => {
            vi.spyOn(fixture.getCodexAcpClient(), "mcpServerOauthLogin").mockRejectedValue(new Error("no OAuth"));
        }],
    ])("does not reload again when the client %s", async (_name, setUp) => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        await enableUrlElicitation(mockFixture);
        mockStatusPages(mockFixture, {
            data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})],
            nextCursor: null,
        });
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("linear", "failed", "OAuth token expired", "reauthenticationRequired"));
            return {};
        });
        setUp(mockFixture);

        await runMcp(mockFixture, "/mcp reconnect");

        expect(reload).toHaveBeenCalledTimes(1);
        const text = messageText(mockFixture);
        expect(text).toContain("The sign-in to MCP server `linear` failed or was cancelled.");
        expect(text).toContain("**Needs authentication**\n- `linear`: not signed in\n");
    });

    it("reports a failure of the second reload after the sign-in", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        await enableUrlElicitation(mockFixture);
        mockFixture.setElicitationResponse({action: "accept"});
        mockStatusPages(mockFixture, {
            data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})],
            nextCursor: null,
        });
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            if (reload.mock.calls.length > 1) {
                throw new Error("config.toml changed\nduring the sign-in");
            }
            mockFixture.sendServerNotification(startupStatus("linear", "failed", "OAuth token expired", "reauthenticationRequired"));
            return {};
        });
        mockOauthLogin(mockFixture);

        await runMcp(mockFixture, "/mcp reconnect");

        expect(reload).toHaveBeenCalledTimes(2);
        const text = messageText(mockFixture);
        expect(text).toContain([
            "- Signed in to MCP server `linear`.",
            "- Could not reload the MCP configuration after the sign-in: config.toml changed during the sign-in",
            "",
            "**MCP servers:**",
        ].join("\n"));
        expect(text.startsWith("**Reconnect:**\n- Reloaded the MCP configuration")).toBe(true);
        expect(text).toContain("**Needs authentication**\n- `linear`: not signed in\n");
    });

    it("rejects a reconnect with more than one server", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const list = mockStatusPages(mockFixture, {data: [server({name: "a"}), server({name: "b"})], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload");

        await runMcp(mockFixture, "/mcp reconnect a b");

        expect(list).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(messageText(mockFixture)).toBe('Command "/mcp" accepts no arguments, or `reconnect [server]`.');
    });

    it("accepts the subcommand in any case, as the command name", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs"})], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "ready"));
            return {};
        });

        await runMcp(mockFixture, "/MCP RECONNECT");

        expect(reload).toHaveBeenCalledTimes(1);
        expect(messageText(mockFixture)).toContain("**Connected**\n- `fs`: 0 tools");
    });

    it("ignores the startup events of another thread", async () => {
        vi.useFakeTimers();
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "starting"})], nextCursor: null});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "failed", "other thread", null, "other-thread"));
            return {};
        });

        mockFixture.clearAcpConnectionDump();
        const prompt = mockFixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/mcp reconnect"}]});
        await vi.advanceTimersByTimeAsync(MCP_RECONNECT_STARTUP_TIMEOUT_MS - 1);
        expect(messageText(mockFixture)).toBe("");
        mockFixture.sendServerNotification(startupStatus("fs", "ready"));
        await prompt;

        const text = messageText(mockFixture);
        expect(text).not.toContain("other thread");
        expect(text).not.toContain("still starting");
    });

    it("counts a startup event without a thread for every thread", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "failed"})], nextCursor: null});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "failed", "global failure", null, null));
            return {};
        });

        await runMcp(mockFixture, "/mcp reconnect");

        expect(messageText(mockFixture)).toContain("**Failed**\n- `fs`: global failure");
    });

    it("sends nothing when the prompt is cancelled during the reconnect", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "failed"})], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockResolvedValue({});
        const cancel = new AbortController();

        mockFixture.clearAcpConnectionDump();
        const prompt = mockFixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/mcp reconnect"}]}, cancel.signal);
        await vi.waitFor(() => expect(reload).toHaveBeenCalled());
        await vi.waitFor(() => expect(pendingStartupWaits(mockFixture)).toBe(1));
        cancel.abort();

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        mockFixture.sendServerNotification(startupStatus("fs", "ready"));
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(messageText(mockFixture)).toBe("");
        expect(pendingStartupWaits(mockFixture)).toBe(0);
    });

    it("fails the reconnect when the Codex connection is disposed during the startup wait", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture, {data: [server({name: "fs", runtimeStatus: "failed"})], nextCursor: null});
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockResolvedValue({});

        mockFixture.clearAcpConnectionDump();
        const prompt = mockFixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/mcp reconnect"}]});
        await vi.waitFor(() => expect(reload).toHaveBeenCalled());
        await vi.waitFor(() => expect(pendingStartupWaits(mockFixture)).toBe(1));
        mockFixture.getCodexAppServerClient().connection.dispose();

        await expect(prompt).rejects.toThrow("Codex connection closed during the MCP server startup.");
        expect(pendingStartupWaits(mockFixture)).toBe(0);
        expect(messageText(mockFixture)).toBe("");
    });

    it("closes the sign-in dialog and sends nothing when the prompt is cancelled during the sign-in", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        await enableUrlElicitation(mockFixture);
        mockFixture.setElicitationResponse(new Promise(() => {}));
        mockStatusPages(mockFixture, {
            data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})],
            nextCursor: null,
        });
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("linear", "failed", "OAuth token expired", "reauthenticationRequired"));
            return {};
        });
        vi.spyOn(mockFixture.getCodexAcpClient(), "mcpServerOauthLogin").mockResolvedValue({
            authorizationUrl: "https://example.com/oauth/authorize",
        });
        const cancel = new AbortController();

        mockFixture.clearAcpConnectionDump();
        const prompt = mockFixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/mcp reconnect"}]}, cancel.signal);
        await vi.waitFor(() => expect(elicitationEvents(mockFixture, "createElicitation")).toHaveLength(1));
        expect(pendingOauthWaits(mockFixture)).toBe(1);
        cancel.abort();

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        await vi.waitFor(() => expect(elicitationEvents(mockFixture, "completeElicitation")).toHaveLength(1));
        expect(pendingOauthWaits(mockFixture)).toBe(0);
        mockFixture.sendServerNotification({
            method: "mcpServer/oauthLogin/completed",
            params: {name: "linear", threadId: sessionId, success: true},
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(messageText(mockFixture)).toBe("");
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("leaves no sign-in wait when the client declines the sign-in", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        await enableUrlElicitation(mockFixture);
        mockFixture.setElicitationResponse({action: "decline"});
        mockStatusPages(mockFixture, {
            data: [server({name: "linear", runtimeStatus: "authenticationRequired", authStatus: "notLoggedIn"})],
            nextCursor: null,
        });
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("linear", "failed", "OAuth token expired", "reauthenticationRequired"));
            return {};
        });
        vi.spyOn(mockFixture.getCodexAcpClient(), "mcpServerOauthLogin").mockResolvedValue({
            authorizationUrl: "https://example.com/oauth/authorize",
        });

        await runMcp(mockFixture, "/mcp reconnect");

        expect(messageText(mockFixture)).toContain("The sign-in to MCP server `linear` failed or was cancelled.");
        expect(elicitationEvents(mockFixture, "completeElicitation")).toHaveLength(0);
        expect(pendingOauthWaits(mockFixture)).toBe(0);
    });

    it("completes two sign-ins to the same server with one notification", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const codexAcpClient = mockFixture.getCodexAcpClient();
        // For example, the startup report and `/mcp reconnect` sign in at the same time.
        const first = codexAcpClient.awaitMcpServerOauthLoginCompleted("linear", sessionId);
        const second = codexAcpClient.awaitMcpServerOauthLoginCompleted("linear", sessionId);

        mockFixture.sendServerNotification({
            method: "mcpServer/oauthLogin/completed",
            params: {name: "linear", threadId: sessionId, success: true},
        });

        await expect(first).resolves.toMatchObject({name: "linear", success: true});
        await expect(second).resolves.toMatchObject({name: "linear", success: true});
        expect(pendingOauthWaits(mockFixture)).toBe(0);
    });

    it("does not wait for a server that the reload removed", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        mockStatusPages(mockFixture,
            {data: [server({name: "fs", runtimeStatus: "failed"}), server({name: "gone", runtimeStatus: "failed"})], nextCursor: null},
            {data: [server({name: "fs", runtimeStatus: "starting"})], nextCursor: null},
            {data: [server({name: "fs"})], nextCursor: null},
        );
        vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockImplementation(async () => {
            mockFixture.sendServerNotification(startupStatus("fs", "ready"));
            return {};
        });

        await runMcp(mockFixture, "/mcp reconnect");

        const text = messageText(mockFixture);
        expect(text).not.toContain("still starting");
        expect(text).not.toContain("gone");
        expect(text).toContain("**Connected**\n- `fs`: 0 tools");
    });

    it("lists the servers without the thread when Codex does not know the thread", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const list = vi.spyOn(mockFixture.getCodexAppServerClient(), "listMcpServerStatus").mockImplementation(async params => {
            if (params.threadId !== undefined) {
                throw new Error(`thread not found: ${params.threadId}`);
            }
            return {data: [server({name: "fs", runtimeStatus: null})], nextCursor: null};
        });
        const reload = vi.spyOn(mockFixture.getCodexAppServerClient(), "mcpServerReload").mockResolvedValue({});

        await runMcp(mockFixture, "/mcp reconnect");

        expect(list).toHaveBeenCalledWith({cursor: null, detail: "toolsAndAuthOnly"});
        expect(reload).toHaveBeenCalledTimes(1);
        expect(pendingStartupWaits(mockFixture)).toBe(0);
        const text = messageText(mockFixture);
        expect(text).not.toContain("still starting");
        expect(text).toContain("**Unknown**\n- `fs`");
    });

    it("does not retry the list without the thread for another error", async () => {
        const {mockFixture} = setupPromptTestSession({sessionId});
        const list = vi.spyOn(mockFixture.getCodexAppServerClient(), "listMcpServerStatus")
            .mockRejectedValue(new Error("MCP status list failed"));

        const prompt = mockFixture.getCodexAcpAgent().prompt({sessionId, prompt: [{type: "text", text: "/mcp"}]});

        await expect(prompt).rejects.toThrow("MCP status list failed");
        expect(list).toHaveBeenCalledTimes(1);
    });
});
