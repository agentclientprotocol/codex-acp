import { describe, expect, it, vi } from "vitest";
import type { ErrorNotification, TurnCompletedNotification } from "../../app-server/v2";
import type { SessionState } from "../../CodexAcpServer";
import {
    createCodexMockTestFixture,
    createTestSessionState,
} from "../acp-test-utils";

const configuredAuthFailureCases: Array<{
    name: string;
    turnError: ErrorNotification["error"];
    sessionOverrides?: Partial<SessionState>;
    expectedData: unknown;
}> = [
    {
        name: "rejected API key",
        sessionOverrides: {
            account: null,
            authConfigured: true,
        },
        turnError: {
            message: "API key was rejected",
            codexErrorInfo: "unauthorized",
            additionalDetails: null,
        },
        expectedData: {
            message: "API key was rejected",
            codexErrorInfo: "unauthorized",
        },
    },
    {
        name: "usage limit exceeded",
        turnError: {
            message: "Usage limits were exceeded",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
        },
        expectedData: {
            message: "Usage limits were exceeded",
            codexErrorInfo: "usageLimitExceeded",
        },
    },
    {
        name: "HTTP 401",
        turnError: {
            message: "Provider returned 401",
            codexErrorInfo: {
                responseStreamDisconnected: {
                    httpStatusCode: 401,
                },
            },
            additionalDetails: "HTTP status 401",
        },
        expectedData: {
            message: "HTTP status 401",
            codexErrorInfo: {
                responseStreamDisconnected: {
                    httpStatusCode: 401,
                },
            },
            additionalDetails: "HTTP status 401",
        },
    },
];

describe("CodexEventHandler - auth error events", () => {
    it("keeps the prompt alive for a retryable HTTP 401", async () => {
        const {result: response, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "retrying-session",
            account: { type: "apiKey" },
        }), {
            message: "Reconnecting after provider returned 401",
            codexErrorInfo: {
                responseStreamDisconnected: {
                    httpStatusCode: 401,
                },
            },
            additionalDetails: "HTTP status 401",
        }, true);

        expect(response).toMatchObject({
            stopReason: "end_turn",
        });
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                codex: {
                    error: {
                        message: "Reconnecting after provider returned 401",
                        codexErrorInfo: {
                            responseStreamDisconnected: {
                                httpStatusCode: 401,
                            },
                        },
                        additionalDetails: "HTTP status 401",
                        turnId: "turn-id",
                        willRetry: true,
                    },
                },
            },
        }]);
    });

    it("returns AuthRequired for auth errors when no auth is configured", async () => {
        const {result: error} = await runPromptWithError(createTestSessionState({
            sessionId: "unauthenticated-session",
            account: null,
            authConfigured: false,
        }), {
            message: "Authentication is required",
            codexErrorInfo: "unauthorized",
            additionalDetails: null,
        });

        expect(error).toMatchObject({
            code: -32000,
            message: "Authentication required: Authentication is required",
            data: {
                message: "Authentication is required",
                codexErrorInfo: "unauthorized",
            },
        });
    });

    it.each(configuredAuthFailureCases)(
        "returns InternalError with details for $name when auth is configured",
        async ({turnError, sessionOverrides, expectedData}) => {
            const {result: error} = await runPromptWithError(createTestSessionState({
                sessionId: "authenticated-session",
                account: { type: "apiKey" },
                ...sessionOverrides,
            }), turnError);

            expect(error).toMatchObject({
                code: -32603,
                message: "Internal error",
                data: expectedData,
            });
            expect(error).not.toMatchObject({
                code: -32000,
            });
        },
    );
});

async function runPromptWithError(
    sessionState: SessionState,
    turnError: ErrorNotification["error"],
    willRetry = false,
): Promise<{result: unknown; updates: unknown[]}> {
    const mockFixture = createCodexMockTestFixture();
    const codexAcpAgent = mockFixture.getCodexAcpAgent();
    const codexAppServerClient = mockFixture.getCodexAppServerClient();
    const turnCompleted = deferred<TurnCompletedNotification>();
    const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
        turn: createTurn("inProgress"),
    });
    vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(turnCompleted.promise);
    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

    const promptPromise = codexAcpAgent.prompt({
        sessionId: sessionState.sessionId,
        prompt: [{ type: "text", text: "test" }],
    });

    await vi.waitFor(() => {
        expect(turnStartSpy).toHaveBeenCalled();
    });

    mockFixture.sendServerNotification({
        method: "error",
        params: {
            threadId: sessionState.sessionId,
            turnId: "turn-id",
            willRetry,
            error: turnError,
        },
    });

    turnCompleted.resolve({
        threadId: sessionState.sessionId,
        turn: createTurn("completed"),
    });

    let result: unknown;
    try {
        result = await promptPromise;
    } catch (error) {
        result = error;
    }
    return {
        result,
        updates: mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update),
    };
}

function createTurn(status: "inProgress" | "completed") {
    return {
        id: "turn-id",
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
