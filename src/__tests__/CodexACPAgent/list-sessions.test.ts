import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { createCodexMockTestFixture } from "../acp-test-utils";
import type { Thread } from "../../app-server/v2";

describe("CodexACPAgent - list sessions", () => {
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

        codexAppServerClient.threadList = vi.fn().mockResolvedValue({
            data: [threadA, threadB],
            nextCursor: "next-cursor",
        });
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
