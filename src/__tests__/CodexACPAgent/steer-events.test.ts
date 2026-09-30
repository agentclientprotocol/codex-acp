import {beforeEach, describe, expect, it, vi} from 'vitest';
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import type {TurnCompletedNotification} from "../../app-server/v2";
import {SESSION_STEERING_METHOD} from "../../AcpExtensions";

function createTurn(id: string, status: "inProgress" | "completed" | "interrupted") {
    return {
        id,
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

/**
 * Drives a prompt to the point where a turn is active (in progress) and paused
 * on turn completion, so a steer can be injected mid-turn.
 */
function startActiveTurn(sessionOverrides?: Partial<SessionState>) {
    const mockFixture = createCodexMockTestFixture();
    const sessionState = createTestSessionState(sessionOverrides);
    vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({
        turn: createTurn("turn-id", "inProgress"),
    });
    const turnCompleted = deferred<TurnCompletedNotification>();
    vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
        .mockReturnValue(turnCompleted.promise);
    vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    return {mockFixture, sessionState, turnCompleted};
}

describe('_session/steering', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reports injected when the input joins the active turn', async () => {
        const {mockFixture, sessionState, turnCompleted} = startActiveTurn();
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "turn-id"});

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "also keep backward compatibility"}],
        })).resolves.toEqual({outcome: "injected"});

        expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: "session-id",
            expectedTurnId: "turn-id",
            input: [{type: "text", text: "also keep backward compatibility", text_elements: []}],
        });

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("turn-id", "completed"),
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it('starts a new turn when no turn is active', async () => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        const turnStartSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "too late for the previous turn"}],
        })).resolves.toEqual({outcome: "startedNewTurn"});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            threadId: "session-id",
            input: [{type: "text", text: "too late for the previous turn", text_elements: []}],
        }));

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("new-turn-id", "completed"),
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBeNull();
        });
    });

    it('starts a new turn when Codex reports that the tracked turn is no longer active', async () => {
        const {mockFixture, sessionState, turnCompleted} = startActiveTurn();
        const nextTurnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValueOnce({turn: createTurn("turn-id", "inProgress")})
            .mockResolvedValueOnce({turn: createTurn("new-turn-id", "inProgress")});
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValueOnce(turnCompleted.promise)
            .mockReturnValueOnce(nextTurnCompleted.promise);
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer").mockImplementation(async () => {
            turnCompleted.resolve({
                threadId: "session-id",
                turn: createTurn("turn-id", "completed"),
            });
            throw Object.assign(new Error("Internal error"), {
                data: {details: "no active turn to steer"},
            });
        });

        const promptPromise = mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "long running prompt"}],
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe("turn-id");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "racing follow-up"}],
        })).resolves.toEqual({outcome: "startedNewTurn"});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(sessionState.currentTurnId).toBe("new-turn-id");

        nextTurnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("new-turn-id", "completed"),
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBeNull();
        });
    });

    it('serializes concurrent late steering requests without dropping either prompt', async () => {
        const mockFixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(mockFixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValue({turn: createTurn("new-turn-id", "inProgress")});
        const turnCompleted = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockReturnValue(turnCompleted.promise);
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer")
            .mockResolvedValue({turnId: "new-turn-id"});

        const firstRequest = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "first late follow-up"}],
        });
        const secondRequest = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "second late follow-up"}],
        });

        await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
            {outcome: "startedNewTurn"},
            {outcome: "injected"},
        ]);
        expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: "session-id",
            expectedTurnId: "new-turn-id",
            input: [{type: "text", text: "second late follow-up", text_elements: []}],
        });

        turnCompleted.resolve({
            threadId: "session-id",
            turn: createTurn("new-turn-id", "completed"),
        });
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBeNull();
        });
    });

    it('reports failed instead of throwing when steering hits an unexpected error', async () => {
        const mockFixture = createCodexMockTestFixture();
        vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockImplementation(() => {
            throw new Error("unexpected boom");
        });

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [{type: "text", text: "keep the agent alive"}],
        })).resolves.toEqual({outcome: "failed"});
    });

    it('rejects malformed steer params', async () => {
        const mockFixture = createCodexMockTestFixture();

        await expect(mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
        })).rejects.toThrow(RequestError);
    });

    it('rejects image input when the model does not support it', async () => {
        const {mockFixture} = startActiveTurn({supportedInputModalities: ["text"]});
        const turnSteerSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "turnSteer");

        const image: acp.ContentBlock = {
            type: "image",
            mimeType: "image/png",
            data: "abc123",
        };

        const error = await mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: "session-id",
            prompt: [image],
        }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(RequestError);
        expect((error as RequestError).data).toContain("does not support image input");
        expect(turnSteerSpy).not.toHaveBeenCalled();
    });
});
