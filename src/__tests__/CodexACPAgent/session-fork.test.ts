import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

describe("ACP session fork", () => {
    it("creates and installs a forked session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const model = createTestModel({id: "gpt-5"});

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        const forkSpy = vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [model],
            collaborationMode: "default",
            modelProvider: "openai",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        const response = await agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });

        expect(response.sessionId).toBe("fork-id");
        expect(agent.getSessionState("fork-id").cwd).toBe("/workspace");
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
        expect(forkSpy).toHaveBeenCalledWith({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });
    });
});
