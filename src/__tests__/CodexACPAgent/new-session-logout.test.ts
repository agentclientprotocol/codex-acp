import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {ModelId} from "../../ModelId";

describe("New session logout handling", () => {
    it("logs out when newSession fails with an error containing log out", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);

        const errorMessage = `Internal error: "failed to reload config: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."`;
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining("You have been logged out. Please try again."),
            });
        expect(logoutSpy).toHaveBeenCalledOnce();
    });

    it("recovers when newSession fails with a failed to reload config error", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);

        const errorMessage = `Internal error: "failed to reload config: Failed to load cloud requirements (workspace-managed policies)."`;
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining("You have been logged out. Please try again."),
            });
        expect(logoutSpy).toHaveBeenCalledOnce();
    });

    it("includes the global config path in reload configuration errors", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        const errorMessage = 'Internal error: "failed to reload config: filesystem path `/tmp` must be absolute, use `~/...`, or start with `:`"';
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        expect(logoutSpy).toHaveBeenCalledTimes(0);
        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining(`Check global and project .codex directories`),
            });
    });

    it("refreshes OpenAI sessions when newSession error forces logout", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel();
        const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const getAccountSpy = vi.spyOn(codexAcpClient, "getAccount")
            .mockResolvedValueOnce({
                account: { type: "apiKey" },
                requiresOpenaiAuth: false,
            })
            .mockResolvedValueOnce({
                account: null,
                requiresOpenaiAuth: true,
            });

        const errorMessage = `Internal error: "failed to reload config: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."`;
        vi.spyOn(codexAcpClient, "newSession")
            .mockResolvedValueOnce({
                sessionId: "openai-session",
                currentModelId,
                models: [model],
                collaborationMode: "default",
                modelProvider: "openai",
                additionalDirectories: [],
            })
            .mockResolvedValueOnce({
                sessionId: "custom-provider-session",
                currentModelId,
                models: [model],
                collaborationMode: "default",
                modelProvider: "custom-provider",
                additionalDirectories: [],
            })
            .mockRejectedValueOnce(new Error(errorMessage));
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        const openAiSession = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});
        const customProviderSession = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});

        await expect(codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining("You have been logged out. Please try again."),
            });

        expect(logoutSpy).toHaveBeenCalledOnce();
        expect(getAccountSpy).toHaveBeenCalledTimes(2);
        expect(codexAcpAgent.getSessionState(openAiSession.sessionId)).toMatchObject({
            account: null,
            authConfigured: false,
        });
        expect(codexAcpAgent.getSessionState(customProviderSession.sessionId)).toMatchObject({
            account: null,
            authConfigured: true,
            authProvider: "custom-provider",
        });
    });
});
