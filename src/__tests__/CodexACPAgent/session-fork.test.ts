import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {ThreadForkResponse} from "../../app-server/v2";

const parentSessionId = "parent-session";
const childSessionId = "child-session";

function createThreadForkResponse(): ThreadForkResponse {
    return {
        thread: {
            id: childSessionId,
            sessionId: childSessionId,
            forkedFromId: parentSessionId,
            parentThreadId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            recencyAt: null,
            status: {type: "idle"},
            path: "/sessions/child-session.jsonl",
            cwd: "/workspace",
            cliVersion: "test",
            source: "appServer",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        },
        model: "model-id",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {type: "dangerFullAccess"},
        reasoningEffort: "medium",
    };
}

describe("ACP session fork", () => {
    it("advertises session fork support", async () => {
        const fixture = createCodexMockTestFixture();

        const response = await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});

        expect(response.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    });

    it("forks a persistent Codex thread and installs the child session", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const model = createTestModel();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAcpClient, "getCurrentModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAcpClient, "getGoal").mockResolvedValue(null);
        vi.spyOn(codexAppServerClient, "skillsExtraRootsSet").mockResolvedValue();
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient.connection, "sendRequest")
            .mockResolvedValue(createThreadForkResponse());
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        const response = await codexAcpAgent.unstable_forkSession({
            sessionId: parentSessionId,
            cwd: "/workspace",
            additionalDirectories: ["/shared"],
            mcpServers: [],
        });

        await expect(fixture.getCodexConnectionDump([], {
            placeholderResponseMethods: ["thread/fork"],
        })).toMatchFileSnapshot("data/session-fork.json");
        expect(response).toMatchObject({
            sessionId: childSessionId,
            modes: {currentModeId: "agent"},
        });
        expect(response.configOptions?.length).toBeGreaterThan(0);
        expect(codexAcpAgent.getSessionState(childSessionId)).toMatchObject({
            sessionId: childSessionId,
            cwd: "/workspace",
            additionalDirectories: ["/shared"],
            currentModelId: "model-id[medium]",
        });
    });

    it("unsubscribes the child when model discovery fails", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getCurrentModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient.connection, "sendRequest")
            .mockResolvedValueOnce(createThreadForkResponse())
            .mockResolvedValueOnce({status: "unsubscribed"});
        vi.spyOn(codexAppServerClient, "listModels").mockRejectedValue(new Error("model list failed"));

        await expect(codexAcpAgent.unstable_forkSession({
            sessionId: parentSessionId,
            cwd: "/workspace",
            mcpServers: [],
        })).rejects.toThrow("model list failed");

        await expect(fixture.getCodexConnectionDump([], {
            placeholderResponseMethods: ["thread/fork"],
        })).toMatchFileSnapshot("data/session-fork-model-list-failed.json");
        expect(() => codexAcpAgent.getSessionState(childSessionId)).toThrow(`Session ${childSessionId} not found`);
    });

    it("normalizes authentication errors from Codex", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getCurrentModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        const errorMessage = "failed to reload config: Please log out and sign in again.";
        vi.spyOn(codexAppServerClient.connection, "sendRequest")
            .mockRejectedValue(new Error(errorMessage));
        const logout = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        await expect(codexAcpAgent.unstable_forkSession({
            sessionId: parentSessionId,
            cwd: "/workspace",
            mcpServers: [],
        })).rejects.toMatchObject({
            data: expect.stringContaining("You have been logged out. Please try again."),
        });
        expect(logout).toHaveBeenCalledOnce();
    });

    it("rejects a fork that reuses the parent session id", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const response = createThreadForkResponse();
        response.thread.id = parentSessionId;
        vi.spyOn(codexAcpClient, "getCurrentModelProvider").mockResolvedValue("openai");
        vi.spyOn(codexAppServerClient, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(codexAppServerClient, "threadFork").mockResolvedValue(response);

        await expect(codexAcpClient.forkSession({
            sessionId: parentSessionId,
            cwd: "/workspace",
            mcpServers: [],
        }, vi.fn())).rejects.toThrow("Codex thread/fork did not return a child session id");
    });
});
