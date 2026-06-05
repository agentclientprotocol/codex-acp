import {describe, expect, it, vi} from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import type {CodexAcpClient} from "../../CodexAcpClient";
import type {TurnStartResponse} from "../../app-server/v2";

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
});

async function createSession(): Promise<{
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

    await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
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
