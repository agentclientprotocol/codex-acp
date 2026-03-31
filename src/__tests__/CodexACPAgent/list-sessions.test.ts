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
            preview: "First session",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 100,
            updatedAt: 200,
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
            preview: "Other session",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 300,
            updatedAt: 400,
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
        const response = await codexAcpAgent.unstable_listSessions(params);

        expect(codexAppServerClient.threadList).toHaveBeenCalledWith(expect.objectContaining({
            sourceKinds: [
                "cli",
                "vscode",
                "exec",
                "appServer",
                "custom",
                "subAgent",
                "subAgentReview",
                "subAgentCompact",
                "subAgentThreadSpawn",
                "subAgentOther",
                "unknown",
            ],
        }));
        await expect(JSON.stringify(response, null, 2)).toMatchFileSnapshot(
            "data/list-sessions.json"
        );
    });
});
