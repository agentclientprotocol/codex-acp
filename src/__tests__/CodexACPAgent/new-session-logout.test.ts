import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture} from "../acp-test-utils";

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
});
