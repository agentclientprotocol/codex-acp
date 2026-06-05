import {describe, expect, it, vi} from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import type {CodexAcpClient} from "../../CodexAcpClient";
import type {McpStartupResult} from "../../CodexAppServerClient";
import type {TurnStartResponse} from "../../app-server/v2";
import type {McpServer} from "@agentclientprotocol/sdk";

const sessionId = "session-id";

describe("ACP session close", () => {
    it("advertises session close support", async () => {
        const fixture = createCodexMockTestFixture();

        const response = await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});

        expect(response.agentCapabilities?.sessionCapabilities?.close).toEqual({});
    });

    it("unsubscribes idle sessions and clears local session handlers", async () => {
        const {fixture, codexAcpAgent} = await createSession();

        mockPromptTurn(fixture, sessionId);
        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "register session handlers"}],
        });

        fixture.clearCodexConnectionDump();
        fixture.clearAcpConnectionDump();

        await codexAcpAgent.closeSession({sessionId});

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot("data/session-close-idle.json");
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);

        fixture.sendServerNotification({
            method: "thread/name/updated",
            params: {
                threadId: sessionId,
                threadName: "Ignored after close",
            },
        });
        await waitForMicrotasks();

        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("interrupts active turns before unsubscribing", async () => {
        const {fixture, codexAcpAgent} = await createSession();
        codexAcpAgent.getSessionState(sessionId).currentTurnId = "turn-id";

        await codexAcpAgent.closeSession({sessionId});

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot("data/session-close-active-turn.json");
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("cancels a prompt when close races with turn start", async () => {
        const {fixture, codexAcpAgent} = await createSession();
        const turnStart = deferred<TurnStartResponse>();
        const turnStartCalled = deferred<void>();

        vi.spyOn(fixture.getCodexAppServerClient(), "turnStart").mockImplementation(async () => {
            turnStartCalled.resolve();
            return await turnStart.promise;
        });

        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await turnStartCalled.promise;
        fixture.clearCodexConnectionDump();

        const closePromise = codexAcpAgent.closeSession({sessionId});
        turnStart.resolve(createTurnStartResponse("turn-id"));

        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});
        await closePromise;

        const requestMethods = fixture.getCodexConnectionEvents([])
            .flatMap(event => event.eventType === "request" ? [event.method] : []);
        expect(requestMethods).toEqual(["turn/interrupt", "thread/unsubscribe"]);
        expect(fixture.getAcpConnectionDump([])).not.toContain("Conversation interrupted");
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("does not hang when close interrupt fails during an active prompt", async () => {
        const {fixture, codexAcpAgent} = await createSession();
        const turnInterruptSpy = vi.spyOn(fixture.getCodexAcpClient(), "turnInterrupt")
            .mockRejectedValue(new Error("interrupt failed"));

        vi.spyOn(fixture.getCodexAppServerClient(), "turnStart").mockResolvedValue(createTurnStartResponse("turn-id"));

        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "long running prompt"}],
        });

        await vi.waitFor(() => {
            expect(codexAcpAgent.getSessionState(sessionId).currentTurnId).toBe("turn-id");
        });
        fixture.clearCodexConnectionDump();

        await expect(codexAcpAgent.closeSession({sessionId})).resolves.toEqual({});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        expect(turnInterruptSpy).toHaveBeenCalledWith({
            threadId: sessionId,
            turnId: "turn-id",
        });
        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-close-interrupt-failed.json"
        );
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("suppresses MCP startup updates while close is in progress", async () => {
        const mcpStartup = deferred<McpStartupResult>();
        const mcpServer: McpServer = {
            name: "broken-mcp",
            command: "npx",
            args: ["broken"],
            env: [],
        };
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession({
            mcpServers: [mcpServer],
            configure: ({codexAcpClient}) => {
                vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(mcpStartup.promise);
            },
        });
        const unsubscribe = deferred<void>();
        vi.spyOn(codexAcpClient, "closeSession").mockReturnValue(unsubscribe.promise);

        await vi.waitFor(() => {
            expect(codexAcpClient.awaitMcpServerStartup).toHaveBeenCalledWith(["broken-mcp"], expect.any(Number));
        });
        fixture.clearAcpConnectionDump();

        const closePromise = codexAcpAgent.closeSession({sessionId});
        await vi.waitFor(() => {
            expect(codexAcpClient.closeSession).toHaveBeenCalledWith(sessionId);
        });

        mcpStartup.resolve({
            ready: [],
            failed: [{server: "broken-mcp", error: "boom"}],
            cancelled: [],
        });
        await waitForMicrotasks();

        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        unsubscribe.resolve(undefined);
        await closePromise;
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
    const model = createTestModel();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId,
        currentModelId: "model-id[medium]",
        models: [model],
        currentServiceTier: null,
    });

    options.configure?.({fixture, codexAcpAgent, codexAcpClient});

    await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: options.mcpServers ?? []});
    fixture.clearCodexConnectionDump();
    fixture.clearAcpConnectionDump();

    return {fixture, codexAcpAgent, codexAcpClient};
}

function createTurnStartResponse(turnId: string): TurnStartResponse {
    return {
        turn: {
            id: turnId,
            items: [],
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        },
    };
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
