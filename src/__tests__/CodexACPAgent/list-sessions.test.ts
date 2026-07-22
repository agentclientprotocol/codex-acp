import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { createCodexMockTestFixture } from "../acp-test-utils";
import type { Thread } from "../../app-server/v2";

describe("CodexACPAgent - list sessions", () => {
    it.each([
        {
            serverCwdBehavior: "string-only",
            acceptsRequestedCwd: (cwd: string | string[] | null | undefined) => cwd === "/repo/project",
        },
        {
            serverCwdBehavior: "string-or-array",
            acceptsRequestedCwd: (cwd: string | string[] | null | undefined) => {
                const cwds = Array.isArray(cwd) ? cwd : cwd ? [cwd] : [];
                return cwds.includes("/repo/project");
            },
        },
    ])("forwards cwd before $serverCwdBehavior thread pagination", async ({acceptsRequestedCwd}) => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);

        const matchingThread = createThread("sess-project", "/repo/project");
        const unrelatedThread = createThread("sess-other", "/repo/other");
        codexAppServerClient.threadList = vi.fn().mockImplementation(async (params) => {
            if (acceptsRequestedCwd(params.cwd)) {
                return {data: [matchingThread], nextCursor: null};
            }
            return {data: [unrelatedThread], nextCursor: "unrelated-global-cursor"};
        });

        const response = await codexAcpAgent.listSessions({
            cwd: "/repo/project",
            cursor: null,
        });

        expect(response).toEqual({
            sessions: [{
                sessionId: "sess-project",
                cwd: "/repo/project",
                title: "Session sess-project",
                updatedAt: "1970-01-01T00:03:20.000Z",
            }],
            nextCursor: null,
        });
    });

    it("forwards cwd, cursor, and CLI ordering across pagination", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAppServerClient.threadList = vi.fn()
            .mockResolvedValueOnce({
                data: [createThread("sess-newer", "/repo/project")],
                nextCursor: "project-page-2",
            })
            .mockResolvedValueOnce({
                data: [createThread("sess-older", "/repo/project")],
                nextCursor: null,
            });

        const firstPage = await codexAcpAgent.listSessions({
            cwd: "/repo/project",
            cursor: null,
        });
        await codexAcpAgent.listSessions({
            cwd: "/repo/project",
            cursor: firstPage.nextCursor ?? null,
        });

        expect(codexAppServerClient.threadList).toHaveBeenNthCalledWith(1, expect.objectContaining({
            cwd: "/repo/project",
            cursor: null,
            sortKey: "updated_at",
            sortDirection: "desc",
        }));
        expect(codexAppServerClient.threadList).toHaveBeenNthCalledWith(2, expect.objectContaining({
            cwd: "/repo/project",
            cursor: "project-page-2",
            sortKey: "updated_at",
            sortDirection: "desc",
        }));
        for (const [params] of vi.mocked(codexAppServerClient.threadList).mock.calls) {
            expect(params).not.toHaveProperty("limit");
        }
    });

    it("returns an empty filtered page without global diagnostics", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAppServerClient.threadList = vi.fn().mockResolvedValue({
            data: [],
            nextCursor: null,
        });

        const response = await codexAcpAgent.listSessions({
            cwd: "/project/new-worktree",
            cursor: null,
        });

        expect(response).toEqual({sessions: [], nextCursor: null});
        expect(codexAppServerClient.threadList).toHaveBeenCalledOnce();
    });

    it("should list sessions filtered by cwd", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);

        const threadA: Thread = {
            id: "sess-1",
            sessionId: "sess-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "First session",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 100,
            updatedAt: 200,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/repo/project",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        const threadB: Thread = {
            id: "sess-2",
            sessionId: "sess-2",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "Other session",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 300,
            updatedAt: 400,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/repo/other",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };

        codexAppServerClient.threadList = vi.fn().mockImplementation(async (params) => ({
            data: [threadA, threadB].filter(thread => thread.cwd === params.cwd),
            nextCursor: "next-cursor",
        }));
        codexAppServerClient.threadLoadedList = vi.fn().mockResolvedValue({
            data: [],
            nextCursor: null,
        });
        codexAppServerClient.threadRead = vi.fn();

        const params: acp.ListSessionsRequest = {
            cwd: "/repo/project",
            cursor: null,
        };
        const response = await codexAcpAgent.listSessions(params);

        expect(codexAppServerClient.threadList).toHaveBeenCalledWith(expect.objectContaining({
            sourceKinds: [
                "cli",
                "vscode",
                "exec",
                "appServer",
                "unknown",
            ],
        }));
        await expect(JSON.stringify(response, null, 2)).toMatchFileSnapshot(
            "data/list-sessions.json"
        );
    });

    it("should prefer the explicit thread name as the session title", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);

        const thread: Thread = {
            id: "sess-1",
            sessionId: "sess-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "Preview text",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 100,
            updatedAt: 200,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/repo/project",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: "Saved title",
            turns: [],
        };

        codexAppServerClient.threadList = vi.fn().mockResolvedValue({
            data: [thread],
            nextCursor: null,
        });

        const response = await codexAcpAgent.listSessions({
            cwd: null,
            cursor: null,
        });

        await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
            "data/list-sessions-thread-name.json"
        );
    });

    it("includes tracked additional directories for active sessions", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "sess-1",
            currentModelId: "gpt-5[medium]",
            models: [{
                id: "gpt-5",
                model: "gpt-5",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "gpt-5",
                description: "test model",
                hidden: false,
                supportedReasoningEfforts: [{reasoningEffort: "medium", description: "balanced"}],
                defaultReasoningEffort: "medium",
                inputModalities: ["text"],
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: true,
            }],
            collaborationMode: "default",
            currentServiceTier: null,
            additionalDirectories: ["/repo/extra"],
        });
        const thread: Thread = {
            id: "sess-1",
            sessionId: "sess-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "First session",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 100,
            updatedAt: 200,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/repo/project",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        vi.spyOn(codexAppServerClient, "threadList").mockResolvedValue({
            data: [thread],
            nextCursor: null,
            backwardsCursor: null,
        });

        await codexAcpAgent.newSession({
            cwd: "/repo/project",
            additionalDirectories: ["/repo/extra"],
            mcpServers: [],
        });

        const response = await codexAcpAgent.listSessions({
            cwd: null,
            cursor: null,
        });

        expect(response.sessions[0]?.additionalDirectories).toEqual(["/repo/extra"]);
    });
});

function createThread(id: string, cwd: string): Thread {
    return {
        id,
        sessionId: id,
        parentThreadId: null,
        threadSource: null,
        forkedFromId: null,
        preview: `Session ${id}`,
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 100,
        updatedAt: 200,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd,
        cliVersion: "0.0.0",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
    };
}
