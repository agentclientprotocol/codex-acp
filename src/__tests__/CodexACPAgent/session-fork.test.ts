import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {McpStartupResult} from "../../CodexAppServerClient";

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
        // Forking creates a session, so the connection reports the account it was
        // created under (`authStatus` extension). Nothing else is sent.
        expect(fixture.getAcpConnectionEvents([])).toEqual([
            {
                method: "notify",
                args: ["_auth/status_update", {authStatus: {kind: "none", label: "Not logged in"}}],
            },
        ]);
        expect(forkSpy).toHaveBeenCalledWith({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [],
        });
    });

    it("waits for MCP startup before completing session fork", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const mcpStartup = deferred<McpStartupResult>();

        vi.spyOn(client, "authRequired").mockResolvedValue(false);
        vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "forkSession").mockResolvedValue({
            sessionId: "fork-id",
            currentModelId: "gpt-5[medium]",
            models: [createTestModel({id: "gpt-5"})],
            collaborationMode: "default",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        const awaitMcpStartupSpy = vi.spyOn(client, "awaitMcpServerStartup")
            .mockReturnValue(mcpStartup.promise);

        const forkPromise = agent.forkSession({
            sessionId: "source-id",
            cwd: "/workspace",
            mcpServers: [{name: "fork-mcp", command: "npx", args: ["fork"], env: []}],
            _meta: {mcpStartupAwaitTimeoutMs: 30_000},
        });
        let forkSettled = false;
        void forkPromise.then(
            () => { forkSettled = true; },
            () => { forkSettled = true; },
        );

        await vi.waitFor(() => {
            expect(awaitMcpStartupSpy).toHaveBeenCalledWith(["fork-mcp"], expect.any(Number));
        });
        expect(forkSettled).toBe(false);

        mcpStartup.resolve({ready: ["fork-mcp"], failed: [], cancelled: []});
        await expect(forkPromise).resolves.toMatchObject({sessionId: "fork-id", modes: expect.any(Object)});
    });
});

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}
