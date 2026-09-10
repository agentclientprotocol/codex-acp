import {afterEach, describe, expect, it, vi} from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import type {CodexAcpClient} from "../../CodexAcpClient";
import type {McpStartupResult} from "../../CodexAppServerClient";
import type {McpServer} from "@agentclientprotocol/sdk";

const sessionId = "session-id";

const mcpServer: McpServer = {
    name: "test-mcp",
    command: "npx",
    args: ["test-mcp"],
    env: [],
};

describe("MCP startup prompt gate", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("does not start a turn before the session MCP servers are ready", async () => {
        const mcpStartup = deferred<McpStartupResult>();
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(mcpStartup.promise);
            },
        });
        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledWith(["test-mcp"], expect.any(Number));
        });

        const turnStart = mockPromptTurn(fixture, sessionId);
        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "use the mcp tool"}],
        });
        await waitForMicrotasks();

        expect(turnStart).not.toHaveBeenCalled();

        mcpStartup.resolve({ready: ["test-mcp"], failed: [], cancelled: []});

        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(turnStart).toHaveBeenCalledTimes(1);
    });

    it("starts the turn immediately when the session has no MCP servers", async () => {
        const {fixture, codexAcpAgent} = await createSession();

        const turnStart = mockPromptTurn(fixture, sessionId);
        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "no mcp needed"}],
        });
        await waitForMicrotasks();

        expect(turnStart).toHaveBeenCalledTimes(1);
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("waits only for the first prompt once startup completed", async () => {
        const mcpStartup = deferred<McpStartupResult>();
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(mcpStartup.promise);
            },
        });
        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledTimes(1);
        });
        mcpStartup.resolve({ready: ["test-mcp"], failed: [], cancelled: []});

        const turnStart = mockPromptTurn(fixture, sessionId);
        await codexAcpAgent.prompt({sessionId, prompt: [{type: "text", text: "first"}]});

        const secondPrompt = codexAcpAgent.prompt({sessionId, prompt: [{type: "text", text: "second"}]});
        await waitForMicrotasks();

        expect(turnStart).toHaveBeenCalledTimes(2);
        await expect(secondPrompt).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("does not delay commands the adapter answers itself", async () => {
        const mcpStartup = deferred<McpStartupResult>();
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(mcpStartup.promise);
            },
        });
        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledTimes(1);
        });

        // Startup is still pending: a local command must answer without waiting for it.
        await expect(codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "/status"}],
        })).resolves.toMatchObject({stopReason: "end_turn"});
        expect(fixture.getAcpConnectionDump([])).toContain("Model:");

        mcpStartup.resolve({ready: ["test-mcp"], failed: [], cancelled: []});
    });

    it("waits for MCP server startup before a command starts a turn", async () => {
        const mcpStartup = deferred<McpStartupResult>();
        const {codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(mcpStartup.promise);
            },
        });
        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledTimes(1);
        });

        const runReview = vi.spyOn(codexAcpClient, "runReview").mockResolvedValue({
            threadId: sessionId,
            turn: {
                id: "review-turn",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "/review"}],
        });
        await waitForMicrotasks();

        expect(runReview).not.toHaveBeenCalled();

        mcpStartup.resolve({ready: ["test-mcp"], failed: [], cancelled: []});

        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(runReview).toHaveBeenCalledTimes(1);
    });

    it("cancels a prompt that is waiting for MCP server startup", async () => {
        const mcpStartup = deferred<McpStartupResult>();
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(mcpStartup.promise);
            },
        });
        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledTimes(1);
        });

        const turnStart = mockPromptTurn(fixture, sessionId);
        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "cancel me"}],
        });
        await waitForMicrotasks();

        await codexAcpAgent.cancel({sessionId});

        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
        expect(turnStart).not.toHaveBeenCalled();

        mcpStartup.resolve({ready: ["test-mcp"], failed: [], cancelled: []});
    });

    it("starts the turn when MCP startup never reports back", async () => {
        vi.stubEnv("MCP_STARTUP_PROMPT_TIMEOUT_MS", "10");
        const neverSettles = new Promise<McpStartupResult>(() => {});
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(neverSettles);
            },
        });
        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledTimes(1);
        });

        const turnStart = mockPromptTurn(fixture, sessionId);
        await expect(codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "first"}],
        })).resolves.toMatchObject({stopReason: "end_turn"});

        // The expired gate must not delay any later prompt again.
        vi.stubEnv("MCP_STARTUP_PROMPT_TIMEOUT_MS", "100000");
        const secondPrompt = codexAcpAgent.prompt({sessionId, prompt: [{type: "text", text: "second"}]});
        await waitForMicrotasks();

        expect(turnStart).toHaveBeenCalledTimes(2);
        await expect(secondPrompt).resolves.toMatchObject({stopReason: "end_turn"});
    });
});

async function createSession(options: {
    mcpServers?: McpServer[],
    configure?: (params: {
        fixture: CodexMockTestFixture,
        codexAcpAgent: CodexAcpServer,
        codexAcpClient: CodexAcpClient,
    }) => void,
} = {}): Promise<{
    fixture: CodexMockTestFixture,
    codexAcpAgent: CodexAcpServer,
    codexAcpClient: CodexAcpClient,
}> {
    const fixture = createCodexMockTestFixture();
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId,
        currentModelId: "model-id[medium]",
        models: [createTestModel()],
        collaborationMode: "default",
        currentServiceTier: null,
        additionalDirectories: [],
    });

    options.configure?.({fixture, codexAcpAgent, codexAcpClient});

    await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: options.mcpServers ?? []});
    fixture.clearCodexConnectionDump();
    fixture.clearAcpConnectionDump();

    return {fixture, codexAcpAgent, codexAcpClient};
}

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

async function waitForMicrotasks(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 10));
}
