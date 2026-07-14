import {describe, expect, it, vi} from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import type {CodexAcpClient, SessionMetadata} from "../../CodexAcpClient";
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

    it("does not wait for delayed turn start before closing", async () => {
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

        await expect(closePromise).resolves.toEqual({});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        const requestMethods = fixture.getCodexConnectionEvents([])
            .flatMap(event => event.eventType === "request" ? [event.method] : []);
        expect(requestMethods).toEqual(["thread/unsubscribe"]);
        expect(fixture.getAcpConnectionDump([])).not.toContain("Conversation interrupted");
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);

        fixture.clearCodexConnectionDump();
        turnStart.resolve(createTurnStartResponse("turn-id"));

        await vi.waitFor(() => {
            const lateRequestMethods = fixture.getCodexConnectionEvents([])
                .flatMap(event => event.eventType === "request" ? [event.method] : []);
            expect(lateRequestMethods).toContain("turn/interrupt");
        });
    });

    it("does not start a turn after close while prompt startup is still refreshing skills", async () => {
        const {fixture, codexAcpAgent} = await createSession();
        const skillRefresh = deferred<{data: []}>();
        const listSkillsSpy = vi.spyOn(fixture.getCodexAppServerClient(), "listSkills")
            .mockReturnValue(skillRefresh.promise);
        const turnStartSpy = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue(createTurnStartResponse("turn-id"));

        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "prompt before turn start"}],
        });

        await vi.waitFor(() => {
            expect(listSkillsSpy).toHaveBeenCalled();
        });

        await expect(codexAcpAgent.closeSession({sessionId})).resolves.toEqual({});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        skillRefresh.resolve({data: []});
        await waitForMicrotasks();

        expect(turnStartSpy).not.toHaveBeenCalled();
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

    it("rejects an in-flight resume that completes after close", async () => {
        const {codexAcpAgent, codexAcpClient} = await createSession();
        const resume = deferred<SessionMetadata>();
        vi.spyOn(codexAcpClient, "resumeSession").mockReturnValue(resume.promise);
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession");

        const resumePromise = codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        });

        await codexAcpAgent.closeSession({sessionId});
        resume.resolve(createSessionMetadata());

        await expect(resumePromise).rejects.toThrow("Invalid request");
        expect(closeSessionSpy).toHaveBeenCalledTimes(2);
        expect(closeSessionSpy).toHaveBeenLastCalledWith(sessionId);
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("does not let a stale resume unsubscribe a newer reopened session", async () => {
        const {codexAcpAgent, codexAcpClient} = await createSession();
        const staleResume = deferred<SessionMetadata>();
        vi.spyOn(codexAcpClient, "resumeSession")
            .mockReturnValueOnce(staleResume.promise)
            .mockResolvedValueOnce(createSessionMetadata());
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession");

        const staleResumePromise = codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        });

        await codexAcpAgent.closeSession({sessionId});
        await codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        });

        staleResume.resolve(createSessionMetadata());

        await expect(staleResumePromise).rejects.toThrow("Invalid request");
        expect(closeSessionSpy).toHaveBeenCalledTimes(1);
        expect(codexAcpAgent.getSessionState(sessionId).sessionId).toBe(sessionId);
    });

    it("blocks reopen while stale resume cleanup is unsubscribing", async () => {
        const {codexAcpAgent, codexAcpClient} = await createSession();
        const staleResume = deferred<SessionMetadata>();
        const staleUnsubscribe = deferred<void>();
        const resumeSpy = vi.spyOn(codexAcpClient, "resumeSession")
            .mockReturnValueOnce(staleResume.promise)
            .mockResolvedValueOnce(createSessionMetadata());
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession")
            .mockResolvedValueOnce()
            .mockReturnValueOnce(staleUnsubscribe.promise);

        const staleResumePromise = codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        });

        await codexAcpAgent.closeSession({sessionId});
        staleResume.resolve(createSessionMetadata());

        await vi.waitFor(() => {
            expect(closeSessionSpy).toHaveBeenCalledTimes(2);
        });

        await expect(codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("Invalid request");
        expect(resumeSpy).toHaveBeenCalledTimes(1);

        staleUnsubscribe.resolve(undefined);
        await expect(staleResumePromise).rejects.toThrow("Invalid request");

        await expect(codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).resolves.toEqual(expect.objectContaining({
            models: expect.objectContaining({
                currentModelId: "model-id[medium]",
            }),
        }));
    });

    it("preserves local close cleanup while stale resume cleanup overlaps close", async () => {
        const {codexAcpAgent, codexAcpClient} = await createSession();
        const staleResume = deferred<SessionMetadata>();
        const activeUnsubscribe = deferred<void>();
        const staleUnsubscribe = deferred<void>();
        vi.spyOn(codexAcpClient, "resumeSession").mockReturnValue(staleResume.promise);
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession")
            .mockReturnValueOnce(activeUnsubscribe.promise)
            .mockReturnValueOnce(staleUnsubscribe.promise);

        const staleResumePromise = codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        });
        const closePromise = codexAcpAgent.closeSession({sessionId});

        await vi.waitFor(() => {
            expect(closeSessionSpy).toHaveBeenCalledTimes(1);
        });

        staleResume.resolve(createSessionMetadata());
        await vi.waitFor(() => {
            expect(closeSessionSpy).toHaveBeenCalledTimes(2);
        });

        activeUnsubscribe.resolve(undefined);
        await expect(closePromise).resolves.toEqual({});
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);

        staleUnsubscribe.resolve(undefined);
        await expect(staleResumePromise).rejects.toThrow("Invalid request");
    });

    it("unsubscribes a resume that fails after app-server subscription", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "resumeSession").mockImplementation(async (_request, onSubscribed) => {
            onSubscribed?.();
            throw new Error("model list failed");
        });
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession").mockResolvedValue();

        await expect(codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("model list failed");

        expect(closeSessionSpy).toHaveBeenCalledWith(sessionId);
    });

    it("unsubscribes a resume that fails during account read after app-server subscription", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "resumeSession").mockImplementation(async (_request, onSubscribed) => {
            onSubscribed?.();
            return createSessionMetadata();
        });
        vi.spyOn(codexAcpClient, "getAccount").mockRejectedValue(new Error("account read failed"));
        const closeSessionSpy = vi.spyOn(codexAcpClient, "closeSession").mockResolvedValue();

        await expect(codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("account read failed");

        expect(closeSessionSpy).toHaveBeenCalledWith(sessionId);
    });

    it("does not route stale turn notifications into a reopened session", async () => {
        const {fixture, codexAcpAgent, codexAcpClient} = await createSession();
        const oldTurnStart = deferred<TurnStartResponse>();
        const turnStartSpy = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart")
            .mockReturnValueOnce(oldTurnStart.promise)
            .mockResolvedValueOnce(createTurnStartResponse("new-turn"));
        vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createCompletedTurn("new-turn"),
        });

        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "old prompt"}],
        });
        await vi.waitFor(() => {
            expect(turnStartSpy).toHaveBeenCalledTimes(1);
        });

        await expect(codexAcpAgent.closeSession({sessionId})).resolves.toEqual({});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "cancelled"});

        vi.spyOn(codexAcpClient, "resumeSession").mockResolvedValue(createSessionMetadata());
        await codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        });
        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "new prompt"}],
        });

        fixture.clearAcpConnectionDump();
        oldTurnStart.resolve(createTurnStartResponse("old-turn"));

        await vi.waitFor(() => {
            const requestMethods = fixture.getCodexConnectionEvents([])
                .flatMap(event => event.eventType === "request" ? [event.method] : []);
            expect(requestMethods).toContain("turn/interrupt");
        });

        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {threadId: sessionId, turnId: "old-turn", itemId: "old-item", delta: "stale"},
        });
        await waitForMicrotasks();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        fixture.sendServerNotification({
            method: "turn/completed",
            params: {
                threadId: sessionId,
                turn: createCompletedTurn("old-turn"),
            },
        });
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {threadId: sessionId, turnId: "new-turn", itemId: "new-item", delta: "fresh"},
        });

        await vi.waitFor(() => {
            expect(fixture.getAcpConnectionDump([])).toContain("fresh");
        });
        expect(fixture.getAcpConnectionDump([])).not.toContain("stale");
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

function createTurnStartResponse(turnId: string): TurnStartResponse {
    return {
        turn: {
            id: turnId,
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        },
    };
}

function createCompletedTurn(turnId: string): TurnStartResponse["turn"] {
    return {
        id: turnId,
        items: [],
        itemsView: "notLoaded",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function createSessionMetadata(): SessionMetadata {
    return {
        sessionId,
        currentModelId: "model-id[medium]",
        models: [createTestModel()],
        collaborationMode: "default",
        currentServiceTier: null,
        additionalDirectories: [],
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
