import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

const clientServer: McpServerStdio = {
    name: "client-mcp",
    command: "/usr/local/bin/client-mcp",
    args: ["--stdio"],
    env: [{name: "TOKEN_ENV", value: "client"}],
};

const strictMeta = {codex: {strictMcpConfig: true}};

/**
 * The effective Codex config: a user-level and a trusted project-level MCP server.
 * A disabled layer's server never loads, so it is not in the effective config.
 */
const configReadResponse = {
    config: {
        mcp_servers: {
            "user-mcp": {url: "https://example.com/user"},
            "project-mcp": {command: "project-mcp"},
        },
    },
    origins: {},
    layers: [
        {
            name: {type: "project", dotCodexFolder: "/elsewhere/.codex"},
            version: "1",
            config: {mcp_servers: {"untrusted-mcp": {command: "untrusted-mcp"}}},
            disabledReason: "untrusted project",
        },
    ],
};

function setUp() {
    const fixture = createCodexMockTestFixture();
    const codexAcpClient = fixture.getCodexAcpClient();
    const codexAppServerClient = fixture.getCodexAppServerClient();

    vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
    vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
    const configReadSpy = vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue(configReadResponse as any);
    const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
        thread: {id: "thread-id"} as any,
        model: "gpt-5",
        reasoningEffort: "medium",
        serviceTier: null,
    } as any);
    const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue({
        thread: {id: "thread-id"} as any,
        model: "gpt-5",
        reasoningEffort: "medium",
        serviceTier: null,
    } as any);
    vi.spyOn(codexAppServerClient, "threadReadWithHistory").mockResolvedValue({
        thread: {id: "thread-id"} as any,
    });
    vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
        data: [createTestModel({id: "gpt-5"})],
        nextCursor: null,
    });

    return {codexAcpClient, configReadSpy, threadStartSpy, threadResumeSpy};
}

describe('_meta.codex.strictMcpConfig', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('gives a session only the client MCP servers and disables every configured one', async () => {
        const {codexAcpClient, threadStartSpy} = setUp();

        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: strictMeta,
        });

        const config = threadStartSpy.mock.calls[0]![0].config!;
        expect(config["mcp_servers"]).toEqual({
            "user-mcp": {enabled: false},
            "project-mcp": {enabled: false},
            "client-mcp": {
                command: "/usr/local/bin/client-mcp",
                args: ["--stdio"],
                env: {TOKEN_ENV: "client"},
            },
        });
    });

    it('turns off the features that add MCP servers of their own', async () => {
        const {codexAcpClient, threadStartSpy} = setUp();

        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: strictMeta,
        });

        expect(threadStartSpy.mock.calls[0]![0].config?.["features"]).toEqual({
            cwd_relative_turn_diffs: false,
            apps: false,
            plugins: false,
            skill_mcp_dependency_install: false,
        });
    });

    it('disables configured servers even when the client passes none', async () => {
        const {codexAcpClient, threadStartSpy} = setUp();

        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [],
            _meta: strictMeta,
        });

        expect(threadStartSpy.mock.calls[0]![0].config?.["mcp_servers"]).toEqual({
            "user-mcp": {enabled: false},
            "project-mcp": {enabled: false},
        });
    });

    it('does not name servers from disabled config layers', async () => {
        const {codexAcpClient, configReadSpy, threadStartSpy} = setUp();

        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [{...clientServer, name: "untrusted-mcp"}],
            _meta: strictMeta,
        });

        expect(configReadSpy).toHaveBeenCalledWith({includeLayers: false, cwd: "/workspace"});
        expect(threadStartSpy.mock.calls[0]![0].config?.["mcp_servers"]).toEqual({
            "user-mcp": {enabled: false},
            "project-mcp": {enabled: false},
            "untrusted-mcp": expect.objectContaining({command: "/usr/local/bin/client-mcp"}),
        });
    });

    it('rejects a client server whose name is also configured', async () => {
        const {codexAcpClient, threadStartSpy} = setUp();

        await expect(codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [{...clientServer, name: "user-mcp"}],
            _meta: strictMeta,
        })).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("user-mcp"),
        });
        expect(threadStartSpy).not.toHaveBeenCalled();
    });

    it('rejects a value that is not a boolean', async () => {
        const {codexAcpClient, threadStartSpy} = setUp();

        await expect(codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: {codex: {strictMcpConfig: "yes"}},
        })).rejects.toMatchObject({code: -32602});
        expect(threadStartSpy).not.toHaveBeenCalled();
    });

    it('leaves configured servers and features alone when absent or false', async () => {
        const {codexAcpClient, threadStartSpy} = setUp();

        await codexAcpClient.newSession({cwd: "/workspace", mcpServers: [clientServer]});
        await codexAcpClient.newSession({
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: {codex: {strictMcpConfig: false}},
        });

        for (const [params] of threadStartSpy.mock.calls) {
            expect(Object.keys(params.config?.["mcp_servers"] as object)).toEqual(["client-mcp"]);
            expect(params.config?.["features"]).toEqual({cwd_relative_turn_diffs: false});
        }
    });

    it('applies to loaded and resumed sessions', async () => {
        const {codexAcpClient, threadResumeSpy} = setUp();

        await codexAcpClient.loadSession({
            sessionId: "load-id",
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: strictMeta,
        });
        await codexAcpClient.resumeSession({
            sessionId: "resume-id",
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: strictMeta,
        });

        for (const [params] of threadResumeSpy.mock.calls) {
            expect(params.config?.["mcp_servers"]).toMatchObject({
                "user-mcp": {enabled: false},
                "project-mcp": {enabled: false},
                "client-mcp": {command: "/usr/local/bin/client-mcp"},
            });
            expect(params.config?.["features"]).toMatchObject({apps: false, plugins: false});
        }
        expect(threadResumeSpy).toHaveBeenCalledTimes(2);
    });

    it('applies to forked sessions', async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "configRead").mockResolvedValue(configReadResponse as any);
        const threadForkSpy = vi.spyOn(codexAppServerClient, "threadFork").mockResolvedValue({
            thread: {id: "fork-id"} as any,
            model: "gpt-5",
            modelProvider: "openai",
            reasoningEffort: "medium",
            serviceTier: null,
        } as any);
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel({id: "gpt-5"})],
            nextCursor: null,
        });

        await codexAcpClient.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [clientServer],
            _meta: strictMeta,
        });

        const config = threadForkSpy.mock.calls[0]![0].config!;
        expect(Object.keys(config["mcp_servers"] as object).sort()).toEqual(["client-mcp", "project-mcp", "user-mcp"]);
        expect(config["mcp_servers"]).toMatchObject({"user-mcp": {enabled: false}, "project-mcp": {enabled: false}});
        expect(config["features"]).toMatchObject({apps: false, plugins: false, skill_mcp_dependency_install: false});
    });
});
