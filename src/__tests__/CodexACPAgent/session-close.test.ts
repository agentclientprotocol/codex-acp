import { describe, expect, it, vi } from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type * as acp from "@agentclientprotocol/sdk";
import type { ServerNotification } from "../../app-server";
import type { McpStartupResult } from "../../CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    SkillsListResponse,
    Thread,
    ThreadItem,
    ThreadResumeResponse,
    Turn,
    TurnStartParams,
    TurnStatus,
} from "../../app-server/v2";

describe("CodexACPAgent - session close", () => {
    it("unsubscribes, releases session state, and unregisters event handlers", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("turn-id", "completed"),
        });
        await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Hello" }],
        });

        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        await agent.closeSession({ sessionId });

        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(() => agent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);

        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: { threadId: sessionId, turnId: "turn-id", itemId: "item-id", delta: "stale" },
        } satisfies ServerNotification);
        await flushAsyncWork();

        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("waits for the active prompt to finish before unsubscribing", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        let resolveCompletion!: (value: { threadId: string; turn: Turn }) => void;
        const completionPromise = new Promise<{ threadId: string; turn: Turn }>((resolve) => {
            resolveCompletion = resolve;
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(completionPromise);
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(codexAppServerClient.awaitTurnCompleted).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        const closePromise = agent.closeSession({ sessionId });

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "turn-id",
            });
        });
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: { threadId: sessionId, turnId: "turn-id", itemId: "item-id", delta: "late" },
        } satisfies ServerNotification);
        await flushAsyncWork();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        resolveCompletion({
            threadId: sessionId,
            turn: createTurn("turn-id", "interrupted"),
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;

        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(interruptSpy.mock.invocationCallOrder[0]!).toBeLessThan(unsubscribeSpy.mock.invocationCallOrder[0]!);
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("suppresses async event updates that finish after close begins", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        let resolveCompletion!: (value: { threadId: string; turn: Turn }) => void;
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(
            new Promise((resolve) => {
                resolveCompletion = resolve;
            })
        );
        vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(codexAppServerClient.awaitTurnCompleted).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: "turn-id",
                item: {
                    type: "fileChange",
                    id: "file-change-id",
                    status: "inProgress",
                    changes: [{
                        path: "/workspace/missing-file.txt",
                        kind: { type: "update", move_path: null },
                        diff: "@@ -1 +1 @@\n-old\n+new\n",
                    }],
                },
            },
        } satisfies ServerNotification);

        const closePromise = agent.closeSession({ sessionId });
        await vi.waitFor(() => {
            expect(codexAppServerClient.turnInterrupt).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "turn-id",
            });
        });

        await flushAsyncWork();
        await flushAsyncWork();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        resolveCompletion({
            threadId: sessionId,
            turn: createTurn("turn-id", "interrupted"),
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;
    });

    it("waits for every in-flight prompt before unsubscribing", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const completions = new Map<string, (value: { threadId: string; turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const turnId = firstInput?.type === "text" && firstInput.text === "First"
                ? "turn-1"
                : "turn-2";
            return Promise.resolve({ turn: createTurn(turnId, "inProgress") });
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockImplementation((threadId, turnId) =>
            new Promise((resolve) => {
                completions.set(turnId, resolve);
            })
        );
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const firstPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "First" }],
        });
        const secondPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Second" }],
        });

        await vi.waitFor(() => {
            expect(completions.has("turn-1")).toBe(true);
            expect(completions.has("turn-2")).toBe(true);
        });

        const closePromise = agent.closeSession({ sessionId });

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({ threadId: sessionId, turnId: "turn-1" });
            expect(interruptSpy).toHaveBeenCalledWith({ threadId: sessionId, turnId: "turn-2" });
        });
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        completions.get("turn-2")!({
            threadId: sessionId,
            turn: createTurn("turn-2", "interrupted"),
        });
        await expect(secondPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await flushAsyncWork();
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        completions.get("turn-1")!({
            threadId: sessionId,
            turn: createTurn("turn-1", "interrupted"),
        });
        await expect(firstPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;

        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
    });

    it("rejects reopening a session while close is in progress", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        let resolveCompletion!: (value: { threadId: string; turn: Turn }) => void;
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(
            new Promise((resolve) => {
                resolveCompletion = resolve;
            })
        );
        vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        let resolveResume!: (value: ThreadResumeResponse) => void;
        const resumeResponse = new Promise<ThreadResumeResponse>((resolve) => {
            resolveResume = resolve;
        });
        const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockReturnValue(resumeResponse);

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(codexAppServerClient.awaitTurnCompleted).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        const inFlightResume = agent.resumeSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });
        await vi.waitFor(() => {
            expect(threadResumeSpy).toHaveBeenCalledTimes(1);
        });

        const closePromise = agent.closeSession({ sessionId });
        await vi.waitFor(() => {
            expect(codexAppServerClient.turnInterrupt).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "turn-id",
            });
        });

        await expect(agent.resumeSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        })).rejects.toThrow("Invalid request");
        expect(threadResumeSpy).toHaveBeenCalledTimes(1);

        resolveCompletion({
            threadId: sessionId,
            turn: createTurn("turn-id", "interrupted"),
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;

        resolveResume(createThreadResumeResponse(sessionId));
        await expect(inFlightResume).rejects.toThrow("Invalid request");
        expect(codexAppServerClient.threadUnsubscribe).toHaveBeenCalledTimes(2);
        expect(() => agent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("rejects a load that is closed before session state exists", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "session-id";
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(agent, "checkAuthorization").mockResolvedValue(undefined);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        let resolveResume!: (value: ThreadResumeResponse) => void;
        const resumeResponse = new Promise<ThreadResumeResponse>((resolve) => {
            resolveResume = resolve;
        });
        const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockReturnValue(resumeResponse);
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel()],
            nextCursor: null,
        });
        const listSkillsSpy = vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({ data: [] });
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const loadPromise = agent.loadSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });

        await vi.waitFor(() => {
            expect(threadResumeSpy).toHaveBeenCalledTimes(1);
        });

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        resolveResume(createThreadResumeResponse(sessionId, createThread(sessionId, [{
            ...createTurn("turn-id", "completed"),
            items: [createAgentMessageItem("history-item", "Loaded history")],
        }])));

        await expect(loadPromise).rejects.toThrow("Invalid request");
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(listSkillsSpy).not.toHaveBeenCalled();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
        expect(() => agent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("rejects a load that is closed while authorization is pending", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "session-id";
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveAuthorization!: () => void;
        const authorizationPromise = new Promise<void>((resolve) => {
            resolveAuthorization = resolve;
        });
        const checkAuthorizationSpy = vi.spyOn(agent, "checkAuthorization").mockReturnValue(authorizationPromise);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        const threadResumeSpy = vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue(
            createThreadResumeResponse(sessionId, createThread(sessionId, [{
                ...createTurn("turn-id", "completed"),
                items: [createAgentMessageItem("history-item", "Loaded history")],
            }]))
        );
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel()],
            nextCursor: null,
        });
        const listSkillsSpy = vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({ data: [] });
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const loadPromise = agent.loadSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });

        await vi.waitFor(() => {
            expect(checkAuthorizationSpy).toHaveBeenCalled();
        });
        expect(threadResumeSpy).not.toHaveBeenCalled();

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        resolveAuthorization();

        await expect(loadPromise).rejects.toThrow("Invalid request");
        expect(threadResumeSpy).toHaveBeenCalledTimes(1);
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(listSkillsSpy).not.toHaveBeenCalled();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
        expect(() => agent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("rejects a resume when close wins immediately before session install", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "session-id";
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(agent, "checkAuthorization").mockResolvedValue(undefined);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue(
            createThreadResumeResponse(sessionId)
        );
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel()],
            nextCursor: null,
        });
        const listSkillsSpy = vi.spyOn(codexAcpClient, "listSkills").mockResolvedValue({ data: [] });
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        let closePromise: Promise<acp.CloseSessionResponse> | null = null;
        vi.spyOn(agent as any, "resolveSessionMcpServers").mockImplementation(() => {
            closePromise = agent.closeSession({ sessionId });
            return [];
        });

        const resumePromise = agent.resumeSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });

        await expect(resumePromise).rejects.toThrow("Invalid request");
        expect(closePromise).not.toBeNull();
        await expect(closePromise!).resolves.toEqual({});
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(listSkillsSpy).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("does not stream loaded history after close wins during load", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "session-id";
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const thread = createThread(sessionId, [{
            ...createTurn("turn-id", "completed"),
            items: [createAgentMessageItem("history-item", "Loaded history")],
        }]);

        vi.spyOn(agent, "checkAuthorization").mockResolvedValue(undefined);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue(
            createThreadResumeResponse(sessionId, thread)
        );
        vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
            data: [createTestModel()],
            nextCursor: null,
        });
        let resolveSkills!: (value: SkillsListResponse) => void;
        const skillsPromise = new Promise<SkillsListResponse>((resolve) => {
            resolveSkills = resolve;
        });
        const listSkillsSpy = vi.spyOn(codexAcpClient, "listSkills").mockReturnValue(skillsPromise);
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const loadPromise = agent.loadSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });

        await vi.waitFor(() => {
            expect(listSkillsSpy).toHaveBeenCalled();
        });

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        fixture.clearAcpConnectionDump();

        resolveSkills({ data: [] });

        await expect(loadPromise).rejects.toThrow("Invalid request");
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("keeps the remaining overlapping turn cancellable after one prompt completes", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const turnId = firstInput?.type === "text" && firstInput.text === "First"
                ? "turn-1"
                : "turn-2";
            return Promise.resolve({ turn: createTurn(turnId, "inProgress") });
        });
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});

        const firstPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "First" }],
        });
        const secondPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Second" }],
        });

        await vi.waitFor(() => {
            expect(awaitTurnCompletedSpy).toHaveBeenCalledWith(sessionId, "turn-1");
            expect(awaitTurnCompletedSpy).toHaveBeenCalledWith(sessionId, "turn-2");
        });

        fixture.sendServerNotification(createTurnCompletedNotification(sessionId, "turn-2"));

        await agent.cancel({ sessionId });

        expect(interruptSpy).toHaveBeenCalledWith({
            threadId: sessionId,
            turnId: "turn-1",
        });
        await expect(secondPrompt).resolves.toMatchObject({ stopReason: "end_turn" });

        fixture.sendServerNotification(createTurnCompletedNotification(sessionId, "turn-1", "interrupted"));

        await expect(firstPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
    });

    it("does not hang when interrupt fails during close", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt")
            .mockRejectedValue(new Error("transport closed"));
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(awaitTurnCompletedSpy).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });

        expect(interruptSpy).toHaveBeenCalledWith({
            threadId: sessionId,
            turnId: "turn-id",
        });
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
    });

    it("cancels a prompt that is waiting before turn start", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveSkills!: (value: SkillsListResponse) => void;
        const skillsPromise = new Promise<SkillsListResponse>((resolve) => {
            resolveSkills = resolve;
        });
        const listSkillsSpy = vi.spyOn(codexAppServerClient, "listSkills").mockReturnValue(skillsPromise);
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart");
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Pre-turn work" }],
        });

        await vi.waitFor(() => {
            expect(listSkillsSpy).toHaveBeenCalled();
        });

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(turnStartSpy).not.toHaveBeenCalled();

        resolveSkills({ data: [] });
        await flushAsyncWork();
        expect(turnStartSpy).not.toHaveBeenCalled();
    });

    it("cancels a slow slash command prompt before unsubscribing", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture, "session-id", {
            availableCommands: new Promise<SkillsListResponse>(() => {}),
        });
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveSkills!: (value: SkillsListResponse) => void;
        const skillsPromise = new Promise<SkillsListResponse>((resolve) => {
            resolveSkills = resolve;
        });
        const listSkillsSpy = vi.spyOn(codexAcpClient, "listSkills").mockReturnValue(skillsPromise);
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/skills" }],
        });

        await vi.waitFor(() => {
            expect(listSkillsSpy).toHaveBeenCalled();
        });

        const closePromise = agent.closeSession({ sessionId });
        fixture.clearAcpConnectionDump();

        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});

        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        resolveSkills({ data: [] });
    });

    it("suppresses queued available command updates after close", async () => {
        const fixture = createCodexMockTestFixture();
        let resolveAvailableCommands!: (value: SkillsListResponse) => void;
        const availableCommandsPromise = new Promise<SkillsListResponse>((resolve) => {
            resolveAvailableCommands = resolve;
        });
        const sessionId = await createSession(fixture, "session-id", {
            availableCommands: availableCommandsPromise,
        });
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        await agent.closeSession({ sessionId });
        fixture.clearAcpConnectionDump();

        resolveAvailableCommands({
            data: [{
                cwd: "/workspace",
                skills: [{
                    name: "build",
                    description: "Build the project",
                    shortDescription: "Build",
                    path: "/workspace/build",
                    scope: "user",
                    enabled: true,
                }],
                errors: [],
            }],
        });
        await flushAsyncWork();
        await flushAsyncWork();

        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("suppresses pending MCP startup updates after close begins", async () => {
        const fixture = createCodexMockTestFixture();
        let resolveMcpStartup!: (value: McpStartupResult) => void;
        const mcpStartupPromise = new Promise<McpStartupResult>((resolve) => {
            resolveMcpStartup = resolve;
        });
        const sessionId = await createSession(fixture, "session-id", {
            mcpServers: [{
                name: "broken-mcp",
                command: "mcp-binary",
                args: [],
                env: [],
            }],
            mcpStartup: mcpStartupPromise,
            availableCommands: new Promise(() => {}),
        });
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        let resolveCompletion!: (value: { threadId: string; turn: Turn }) => void;
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(
            new Promise((resolve) => {
                resolveCompletion = resolve;
            })
        );
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(codexAppServerClient.awaitTurnCompleted).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        const closePromise = agent.closeSession({ sessionId });
        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({ threadId: sessionId, turnId: "turn-id" });
        });

        fixture.clearAcpConnectionDump();
        resolveMcpStartup({
            ready: [],
            failed: [{ server: "broken-mcp", error: "boom" }],
            cancelled: [],
        });
        await flushAsyncWork();
        await flushAsyncWork();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        resolveCompletion({
            threadId: sessionId,
            turn: createTurn("turn-id", "interrupted"),
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;
    });

    it("cancels a pending turn start without waiting for an id", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        const turnStartPromise = new Promise<{ turn: Turn }>(() => {});
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockReturnValue(turnStartPromise);
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Start a turn" }],
        });

        await vi.waitFor(() => {
            expect(turnStartSpy).toHaveBeenCalled();
        });

        const closePromise = agent.closeSession({ sessionId });

        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});
        expect(interruptSpy).not.toHaveBeenCalled();
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(getTurnCompletionCaptureCount(codexAppServerClient)).toBe(0);
    });

    it("fences delayed turn-start notifications before a reopened prompt subscribes", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const turnStartResolvers = new Map<string, (value: { turn: Turn }) => void>();
        const completionResolvers = new Map<string, (value: { threadId: string; turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const text = firstInput?.type === "text" ? firstInput.text : "";
            return new Promise((resolve) => {
                turnStartResolvers.set(text, resolve);
            });
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockImplementation((threadId, turnId) =>
            new Promise((resolve) => {
                completionResolvers.set(turnId, resolve);
            })
        );
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue(
            createThreadResumeResponse(sessionId)
        );

        const oldPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Old" }],
        });

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("Old")).toBe(true);
        });

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        await expect(oldPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });

        await agent.resumeSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });

        fixture.clearAcpConnectionDump();
        const reopenedPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "New" }],
        });
        await flushAsyncWork();
        expect(turnStartResolvers.has("New")).toBe(false);

        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: sessionId,
                turnId: "old-turn-id",
                itemId: "old-item-id",
                delta: "stale",
            },
        } satisfies ServerNotification);

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("New")).toBe(true);
        });
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
        expect(interruptSpy).toHaveBeenCalledWith({
            threadId: sessionId,
            turnId: "old-turn-id",
        });

        turnStartResolvers.get("Old")!({ turn: createTurn("old-turn-id", "inProgress") });
        turnStartResolvers.get("New")!({ turn: createTurn("new-turn-id", "inProgress") });
        await vi.waitFor(() => {
            expect(completionResolvers.has("new-turn-id")).toBe(true);
        });

        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: {
                threadId: sessionId,
                turnId: "old-turn-id",
                itemId: "old-item-id",
                delta: "still stale",
            },
        } satisfies ServerNotification);
        await flushAsyncWork();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        completionResolvers.get("new-turn-id")!({
            threadId: sessionId,
            turn: createTurn("new-turn-id", "completed"),
        });
        await expect(reopenedPrompt).resolves.toMatchObject({ stopReason: "end_turn" });
    });

    it("cancels a reopened prompt that is waiting on an unidentified stale turn-start fence", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const turnStartResolvers = new Map<string, (value: { turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const text = firstInput?.type === "text" ? firstInput.text : "";
            return new Promise((resolve) => {
                turnStartResolvers.set(text, resolve);
            });
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("new-turn-id", "completed"),
        });
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        vi.spyOn(codexAppServerClient, "threadResume").mockResolvedValue(
            createThreadResumeResponse(sessionId)
        );

        const oldPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Old" }],
        });

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("Old")).toBe(true);
        });

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        await expect(oldPrompt).resolves.toMatchObject({ stopReason: "cancelled" });

        await agent.resumeSession({
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
        });

        const reopenedPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "New" }],
        });
        await flushAsyncWork();
        expect(turnStartResolvers.has("New")).toBe(false);

        await expect(agent.closeSession({ sessionId })).resolves.toEqual({});
        await expect(reopenedPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        expect(turnStartResolvers.has("New")).toBe(false);
        expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
        expect(unsubscribeSpy).toHaveBeenLastCalledWith({ threadId: sessionId });
    });

    it("interrupts a delayed turn start response after close completes", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveTurnStart!: (value: { turn: Turn }) => void;
        const turnStartPromise = new Promise<{ turn: Turn }>((resolve) => {
            resolveTurnStart = resolve;
        });
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockReturnValue(turnStartPromise);
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("delayed-response-turn-id", "interrupted"),
        });
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Start a turn" }],
        });

        await vi.waitFor(() => {
            expect(turnStartSpy).toHaveBeenCalled();
        });

        const closePromise = agent.closeSession({ sessionId });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});
        expect(interruptSpy).not.toHaveBeenCalled();
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });

        resolveTurnStart({ turn: createTurn("delayed-response-turn-id", "inProgress") });

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "delayed-response-turn-id",
            });
        });
    });

    it("interrupts a turn-start notification that arrives after close begins", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveTurnStart!: (value: { turn: Turn }) => void;
        const turnStartPromise = new Promise<{ turn: Turn }>((resolve) => {
            resolveTurnStart = resolve;
        });
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockReturnValue(turnStartPromise);
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("late-notification-turn-id", "interrupted"),
        });
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Start a turn" }],
        });

        await vi.waitFor(() => {
            expect(turnStartSpy).toHaveBeenCalled();
        });

        const closePromise = agent.closeSession({ sessionId });
        expect(interruptSpy).not.toHaveBeenCalled();
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        fixture.clearAcpConnectionDump();
        fixture.sendServerNotification({
            method: "item/agentMessage/delta",
            params: { threadId: sessionId, turnId: "late-notification-turn-id", itemId: "item-id", delta: "late" },
        } satisfies ServerNotification);
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "late-notification-turn-id"));

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "late-notification-turn-id",
            });
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
        expect(getTurnCompletionCaptureCount(codexAppServerClient)).toBe(0);

        resolveTurnStart({ turn: createTurn("late-notification-turn-id", "inProgress") });
        await flushAsyncWork();
        expect(interruptSpy).toHaveBeenCalledTimes(1);
    });

    it("interrupts a known unassigned turn before cancelling overlapping pending turn starts", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const turnStartResolvers = new Map<string, (value: { turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const text = firstInput?.type === "text" ? firstInput.text : "";
            return new Promise((resolve) => {
                turnStartResolvers.set(text, resolve);
            });
        });
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        let resolveInterrupt!: (value: Awaited<ReturnType<typeof codexAppServerClient.turnInterrupt>>) => void;
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockReturnValue(
            new Promise<Awaited<ReturnType<typeof codexAppServerClient.turnInterrupt>>>((resolve) => {
                resolveInterrupt = resolve;
            })
        );
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const firstPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "First" }],
        });
        const secondPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Second" }],
        });

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("First")).toBe(true);
            expect(turnStartResolvers.has("Second")).toBe(true);
        });
        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "observed-turn-id"));

        const closePromise = agent.closeSession({ sessionId });
        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "observed-turn-id",
            });
        });
        expect(interruptSpy).toHaveBeenCalledTimes(1);
        expect(unsubscribeSpy).not.toHaveBeenCalled();

        resolveInterrupt({});

        await expect(firstPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(secondPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
    });

    it("retries a failed interrupt when a delayed turn start returns after synthetic completion", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveTurnStart!: (value: { turn: Turn }) => void;
        const turnStartPromise = new Promise<{ turn: Turn }>((resolve) => {
            resolveTurnStart = resolve;
        });
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockReturnValue(turnStartPromise);
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt")
            .mockRejectedValueOnce(new Error("turn not ready"))
            .mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        const realResolveInterruptedTurn = codexAcpClient.resolveInterruptedTurn.bind(codexAcpClient);
        vi.spyOn(codexAcpClient, "resolveInterruptedTurn").mockImplementation((params) => {
            realResolveInterruptedTurn(params);
            resolveTurnStart({ turn: createTurn(params.turnId, "inProgress") });
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Start a turn" }],
        });

        await vi.waitFor(() => {
            expect(turnStartSpy).toHaveBeenCalled();
        });
        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "observed-turn-id"));

        const closePromise = agent.closeSession({ sessionId });
        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledTimes(2);
        });

        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        expect(interruptSpy).toHaveBeenNthCalledWith(1, {
            threadId: sessionId,
            turnId: "observed-turn-id",
        });
        expect(interruptSpy).toHaveBeenNthCalledWith(2, {
            threadId: sessionId,
            turnId: "observed-turn-id",
        });
        expect(interruptSpy.mock.invocationCallOrder[1]!).toBeLessThan(unsubscribeSpy.mock.invocationCallOrder[0]!);
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
    });

    it("does not assign an observed turn-start notification to an arbitrary overlapping prompt", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const turnStartResolvers = new Map<string, (value: { turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const text = firstInput?.type === "text" ? firstInput.text : "";
            return new Promise((resolve) => {
                turnStartResolvers.set(text, resolve);
            });
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockImplementation((threadId, turnId) =>
            Promise.resolve({
                threadId,
                turn: createTurn(turnId, "interrupted"),
            })
        );
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const firstPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "First" }],
        });
        const secondPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Second" }],
        });

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("First")).toBe(true);
            expect(turnStartResolvers.has("Second")).toBe(true);
        });

        const closePromise = agent.closeSession({ sessionId });
        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "observed-turn-id"));

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "observed-turn-id",
            });
        });
        await expect(firstPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(secondPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });

        turnStartResolvers.get("First")!({ turn: createTurn("first-response-turn-id", "inProgress") });
        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "first-response-turn-id",
            });
        });

        turnStartResolvers.get("Second")!({ turn: createTurn("second-response-turn-id", "inProgress") });
        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "second-response-turn-id",
            });
        });

        expect(interruptSpy).toHaveBeenCalledTimes(3);
    });

    it("cancels ambiguous pending prompts when an observed turn interrupt fails", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const turnStartResolvers = new Map<string, (value: { turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const text = firstInput?.type === "text" ? firstInput.text : "";
            return new Promise((resolve) => {
                turnStartResolvers.set(text, resolve);
            });
        });
        const awaitTurnCompletedSpy = vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt")
            .mockRejectedValue(new Error("transport closed"));
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const firstPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "First" }],
        });
        const secondPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Second" }],
        });

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("First")).toBe(true);
            expect(turnStartResolvers.has("Second")).toBe(true);
        });

        const closePromise = agent.closeSession({ sessionId });
        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "observed-turn-id"));

        await expect(firstPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(secondPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});

        expect(interruptSpy).toHaveBeenCalledTimes(1);
        expect(interruptSpy).toHaveBeenCalledWith({
            threadId: sessionId,
            turnId: "observed-turn-id",
        });
        expect(awaitTurnCompletedSpy).not.toHaveBeenCalled();
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });
    });

    it("retries a failed observed-turn interrupt when a delayed turn start response reports the same id", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const turnStartResolvers = new Map<string, (value: { turn: Turn }) => void>();

        vi.spyOn(codexAppServerClient, "turnStart").mockImplementation((params: TurnStartParams) => {
            const firstInput = params.input[0];
            const text = firstInput?.type === "text" ? firstInput.text : "";
            return new Promise((resolve) => {
                turnStartResolvers.set(text, resolve);
            });
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted");
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt")
            .mockRejectedValueOnce(new Error("turn not ready"))
            .mockResolvedValue({});
        const unsubscribeSpy = vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const firstPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "First" }],
        });
        const secondPrompt = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Second" }],
        });

        await vi.waitFor(() => {
            expect(turnStartResolvers.has("First")).toBe(true);
            expect(turnStartResolvers.has("Second")).toBe(true);
        });
        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "observed-turn-id"));

        const closePromise = agent.closeSession({ sessionId });
        await expect(firstPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(secondPrompt).resolves.toMatchObject({ stopReason: "cancelled" });
        await expect(closePromise).resolves.toEqual({});
        expect(interruptSpy).toHaveBeenCalledTimes(1);
        expect(interruptSpy).toHaveBeenCalledWith({
            threadId: sessionId,
            turnId: "observed-turn-id",
        });
        expect(unsubscribeSpy).toHaveBeenCalledWith({ threadId: sessionId });

        turnStartResolvers.get("First")!({ turn: createTurn("observed-turn-id", "inProgress") });

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledTimes(2);
        });
        expect(interruptSpy).toHaveBeenLastCalledWith({
            threadId: sessionId,
            turnId: "observed-turn-id",
        });
    });

    it("cancels permission requests that arrive after close begins", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        let resolveCompletion!: (value: { threadId: string; turn: Turn }) => void;
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(
            new Promise((resolve) => {
                resolveCompletion = resolve;
            })
        );
        vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(codexAppServerClient.awaitTurnCompleted).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        const closePromise = agent.closeSession({ sessionId });
        await vi.waitFor(() => {
            expect(codexAppServerClient.turnInterrupt).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "turn-id",
            });
        });

        fixture.clearAcpConnectionDump();
        const approvalParams: CommandExecutionRequestApprovalParams = {
            threadId: sessionId,
            turnId: "turn-id",
            itemId: "approval-id",
            command: "echo hi",
            cwd: "/workspace",
            reason: null,
            proposedExecpolicyAmendment: null,
        };
        const response = await fixture.sendServerRequest<CommandExecutionRequestApprovalResponse>(
            "item/commandExecution/requestApproval",
            approvalParams
        );

        expect(response).toEqual({ decision: "cancel" });
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);

        resolveCompletion({
            threadId: sessionId,
            turn: createTurn("turn-id", "interrupted"),
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;
    });

    it("cancels already-open permission requests when close begins", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("turn-id", "inProgress"),
        });
        let resolveCompletion!: (value: { threadId: string; turn: Turn }) => void;
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(
            new Promise((resolve) => {
                resolveCompletion = resolve;
            })
        );
        vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });
        let resolvePermission!: (value: acp.RequestPermissionResponse) => void;
        fixture.setPermissionResponse(new Promise((resolve) => {
            resolvePermission = resolve;
        }));

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Active work" }],
        });

        await vi.waitFor(() => {
            expect(codexAppServerClient.awaitTurnCompleted).toHaveBeenCalledWith(sessionId, "turn-id");
        });

        const approvalParams: CommandExecutionRequestApprovalParams = {
            threadId: sessionId,
            turnId: "turn-id",
            itemId: "approval-id",
            command: "echo hi",
            cwd: "/workspace",
            reason: null,
            proposedExecpolicyAmendment: null,
        };
        const approvalPromise = fixture.sendServerRequest<CommandExecutionRequestApprovalResponse>(
            "item/commandExecution/requestApproval",
            approvalParams
        );

        await vi.waitFor(() => {
            expect(fixture.getAcpConnectionEvents([]).some(event => event.method === "requestPermission")).toBe(true);
        });

        const closePromise = agent.closeSession({ sessionId });

        await expect(approvalPromise).resolves.toEqual({ decision: "cancel" });
        await vi.waitFor(() => {
            expect(codexAppServerClient.turnInterrupt).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "turn-id",
            });
        });

        resolvePermission({
            outcome: { outcome: "selected", optionId: "allow_once" },
        });
        resolveCompletion({
            threadId: sessionId,
            turn: createTurn("turn-id", "interrupted"),
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;
    });

    it("interrupts a turn that started before the turn start response resolves", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = await createSession(fixture);
        const agent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        let resolveTurnStart!: (value: { turn: Turn }) => void;
        const turnStartPromise = new Promise<{ turn: Turn }>((resolve) => {
            resolveTurnStart = resolve;
        });
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockReturnValue(turnStartPromise);
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn("early-turn-id", "interrupted"),
        });
        const interruptSpy = vi.spyOn(codexAppServerClient, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(codexAppServerClient, "threadUnsubscribe").mockResolvedValue({
            status: "unsubscribed",
        });

        const promptPromise = agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Start a turn" }],
        });

        await vi.waitFor(() => {
            expect(turnStartSpy).toHaveBeenCalled();
        });

        fixture.sendServerNotification(createTurnStartedNotification(sessionId, "early-turn-id"));
        const closePromise = agent.closeSession({ sessionId });

        await vi.waitFor(() => {
            expect(interruptSpy).toHaveBeenCalledWith({
                threadId: sessionId,
                turnId: "early-turn-id",
            });
        });
        await expect(promptPromise).resolves.toMatchObject({ stopReason: "cancelled" });
        await closePromise;
        expect(codexAppServerClient.threadUnsubscribe).toHaveBeenCalledWith({ threadId: sessionId });

        resolveTurnStart({ turn: createTurn("early-turn-id", "inProgress") });
        await flushAsyncWork();
        expect(interruptSpy).toHaveBeenCalledTimes(1);
    });
});

async function createSession(
    fixture: CodexMockTestFixture,
    sessionId = "session-id",
    options: {
        availableCommands?: Promise<SkillsListResponse>;
        mcpServers?: acp.McpServer[];
        mcpStartup?: Promise<McpStartupResult>;
    } = {}
): Promise<string> {
    const agent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();
    const codexAppServerClient = fixture.getCodexAppServerClient();

    vi.spyOn(agent, "checkAuthorization").mockResolvedValue(undefined);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({
        account: null,
        requiresOpenaiAuth: false,
    });
    vi.spyOn(codexAcpClient, "listSkills").mockReturnValue(options.availableCommands ?? Promise.resolve({ data: [] }));
    if (options.mcpStartup) {
        vi.spyOn(codexAcpClient, "awaitMcpServerStartup").mockReturnValue(options.mcpStartup);
    }
    vi.spyOn(codexAppServerClient, "threadStart").mockResolvedValue({
        thread: createThread(sessionId),
        model: "model-id",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        reasoningEffort: "medium",
    });
    vi.spyOn(codexAppServerClient, "listModels").mockResolvedValue({
        data: [createTestModel()],
        nextCursor: null,
    });

    const response = await agent.newSession({ cwd: "/workspace", mcpServers: options.mcpServers ?? [] });
    expect(response.sessionId).toBe(sessionId);
    fixture.clearAcpConnectionDump();
    fixture.clearCodexConnectionDump();
    return response.sessionId;
}

function createThread(sessionId: string, turns: Turn[] = []): Thread {
    return {
        id: sessionId,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 0,
        updatedAt: 0,
        status: { type: "idle" },
        path: null,
        cwd: "/workspace",
        cliVersion: "0.0.0",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns,
    };
}

function createThreadResumeResponse(sessionId: string, thread = createThread(sessionId)): ThreadResumeResponse {
    return {
        thread,
        model: "model-id",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        reasoningEffort: "medium",
    };
}

function createAgentMessageItem(id: string, text: string): ThreadItem {
    return {
        type: "agentMessage",
        id,
        text,
        phase: null,
        memoryCitation: null,
    };
}

function createTurn(id: string, status: TurnStatus): Turn {
    return {
        id,
        items: [],
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function createTurnCompletedNotification(
    threadId: string,
    turnId: string,
    status: TurnStatus = "completed"
): ServerNotification {
    return {
        method: "turn/completed",
        params: {
            threadId,
            turn: createTurn(turnId, status),
        },
    };
}

function createTurnStartedNotification(threadId: string, turnId: string): ServerNotification {
    return {
        method: "turn/started",
        params: {
            threadId,
            turn: createTurn(turnId, "inProgress"),
        },
    };
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function getTurnCompletionCaptureCount(codexAppServerClient: unknown): number {
    return (codexAppServerClient as { turnCompletionCaptures: Map<string, unknown> }).turnCompletionCaptures.size;
}
