import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type { ErrorNotification, TurnCompletedNotification } from "../../app-server/v2";
import type { SessionState } from "../../CodexAcpServer";
import {
    createCodexMockTestFixture,
    createTestSessionState,
} from "../acp-test-utils";
import {logger} from "../../Logger";
import {CodexEventHandler} from "../../CodexEventHandler";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import {CodexCommands, type CommandHandleResult} from "../../CodexCommands";

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

const typedFailureCapabilities: acp.ClientCapabilities = {
    _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}},
};

describe("CodexEventHandler - auth error events", () => {
    it("publishes a typed terminal failure instead of assistant text when AIR negotiated it", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "typed-failure-session",
            account: { type: "apiKey" },
        }), {
            message: "raw upstream payload must not be shown",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: "secret raw details",
        }, false, typedFailureCapabilities);

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        sessionFailure: {
                            id: "turn-id:error",
                            revision: 1,
                            phase: "active",
                            category: "overloaded",
                            source: "codex",
                            safeMessage: "Codex is temporarily overloaded.",
                            retryable: true,
                            actions: ["retry"],
                            turnId: "turn-id",
                        },
                    },
                },
            },
        });
        expect(JSON.stringify(result)).not.toContain("raw upstream payload");
        expect(JSON.stringify(result)).not.toContain("secret raw details");
        expect(updates).toEqual([]);

        const wire = JSON.parse(JSON.stringify({jsonrpc: "2.0", id: 1, result}));
        expect(wire.result._meta.jetbrains.air.sessionFailure).toEqual(
            expect.objectContaining({id: "turn-id:error", category: "overloaded"}),
        );
    });

    it("does not attach a foreign turn failure to the active prompt", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "foreign-turn-session",
            account: { type: "apiKey" },
        }), {
            message: "another turn failed",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: "secret foreign-turn details",
        }, false, typedFailureCapabilities, "foreign-turn");

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("sessionFailure");
        expect(JSON.stringify(updates)).not.toContain("another turn failed");
        expect(JSON.stringify(updates)).not.toContain("secret foreign-turn details");
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                codex: {
                    error: {
                        category: "overloaded",
                        message: "Codex is temporarily overloaded.",
                        turnId: "foreign-turn",
                        willRetry: false,
                    },
                },
            },
        }]);
    });

    it("does not attach a foreign error that arrives before the active turn id", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "early-foreign-turn-session",
            account: { type: "apiKey" },
        }), {
            message: "a delayed previous turn failure",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
        }, false, typedFailureCapabilities, "foreign-turn", true);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("sessionFailure");
    });

    it("buffers a current-turn error until the active turn id is known", async () => {
        const log = vi.spyOn(logger, "log");
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "early-current-turn-session",
            account: { type: "apiKey" },
        }), {
            message: "current turn failed early",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
        }, false, typedFailureCapabilities, "turn-id", true);

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {turnId: "turn-id", category: "overloaded"}}}},
        });
        expect(updates).toEqual([]);
        const logText = JSON.stringify(log.mock.calls);
        expect(logText).toContain("Buffered app-server error");
        expect(logText).not.toContain("current turn failed early");
        log.mockRestore();
    });

    it("does not publish a terminal failure while Codex will retry", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "typed-retrying-session",
            account: { type: "apiKey" },
        }), {
            message: "raw retry payload",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: "secret retry details",
        }, true, typedFailureCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("sessionFailure");
        expect(JSON.stringify(updates)).not.toContain("raw retry payload");
        expect(JSON.stringify(updates)).not.toContain("secret retry details");
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                codex: {
                    error: {
                        category: "overloaded",
                        message: "Codex is temporarily overloaded.",
                        turnId: "turn-id",
                        willRetry: true,
                    },
                },
            },
        }]);
    });

    it("publishes a safe rate-limit diagnostic while Codex retries HTTP 429", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "typed-rate-limit-retry-session",
            account: { type: "apiKey" },
        }), {
            message: "raw 429 retry payload",
            codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: 429}},
            additionalDetails: "secret rate-limit details",
        }, true, typedFailureCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("raw 429 retry payload");
        expect(JSON.stringify(updates)).not.toContain("secret rate-limit details");
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                codex: {
                    error: {
                        category: "rate_limited",
                        message: "The Codex rate limit was reached.",
                        turnId: "turn-id",
                        willRetry: true,
                    },
                },
            },
        }]);
    });

    it("returns a typed auth failure without forwarding provider details", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "typed-auth-session",
            account: null,
            authConfigured: false,
        }), {
            message: "raw authentication payload",
            codexErrorInfo: "unauthorized",
            additionalDetails: "secret authentication details",
        }, false, typedFailureCapabilities);

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {category: "auth_required"}}}},
        });
        expect(JSON.stringify(result)).not.toContain("raw authentication payload");
        expect(JSON.stringify(result)).not.toContain("secret authentication details");
        expect(updates).toEqual([]);
    });

    it("accepts a newer additive typed-failure capability version", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "newer-capability-session",
            account: { type: "apiKey" },
        }), {
            message: "raw newer-version error",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
        }, false, {_meta: {jetbrains: {air: {version: 2, capabilities: ["sessionFailure"]}}}});

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {version: 1, sessionFailure: {category: "overloaded"}}}},
        });
        expect(JSON.stringify(result)).not.toContain("raw newer-version error");
        expect(updates).toEqual([]);
    });

    it.each([null, "1", 1.1, 0, -1])("ignores malformed AIR capability version %s", async (version) => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: `malformed-version-${String(version)}`,
            account: {type: "apiKey"},
        }), {
            message: "legacy fallback",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
        }, false, {_meta: {jetbrains: {air: {version, capabilities: ["sessionFailure"]}}}} as acp.ClientCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(result)).not.toContain("sessionFailure");
        expect(updates).toEqual([expect.objectContaining({sessionUpdate: "agent_message_chunk"})]);
    });

    it.each([
        ["transport_lost", {responseStreamDisconnected: {httpStatusCode: 503}}],
        ["auth_required", "unauthorized"],
        ["rate_limited", {responseStreamDisconnected: {httpStatusCode: 429}}],
        ["quota_exhausted", "usageLimitExceeded"],
        ["overloaded", "serverOverloaded"],
        ["context_exhausted", "contextWindowExceeded"],
        ["budget_exhausted", "sessionBudgetExceeded"],
        ["policy_denied", "cyberPolicy"],
        ["bad_request", "badRequest"],
        ["internal_error", "internalServerError"],
        ["provider_error", "threadRollbackFailed"],
        ["provider_error", "sandboxError"],
        ["provider_error", "other"],
        ["transport_lost", {httpConnectionFailed: {httpStatusCode: null}}],
        ["transport_lost", {responseStreamConnectionFailed: {httpStatusCode: 503}}],
        ["transport_lost", {responseTooManyFailedAttempts: {httpStatusCode: 503}}],
        ["provider_error", {activeTurnNotSteerable: {turnKind: "review"}}],
    ] as const)("maps a terminal Codex error to %s", async (category, codexErrorInfo) => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: `category-${category}`,
            account: { type: "apiKey" },
        }), {
            message: "raw error",
            codexErrorInfo,
            additionalDetails: null,
        }, false, typedFailureCapabilities);

        expect(result).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {category}}}},
        });
        expect(updates).toEqual([]);
    });

    it("clears the active failure with the same id and a greater revision after recovery", async () => {
        const sessionState = createTestSessionState({
            sessionId: "recovered-session",
            account: { type: "apiKey" },
            sessionFailure: {
                id: "failed-turn:error",
                revision: 3,
                phase: "active",
                category: "overloaded",
                source: "codex",
                safeMessage: "Codex is temporarily overloaded.",
                retryable: true,
                actions: ["retry"],
                turnId: "failed-turn",
            },
        });

        const {result, updates} = await runSuccessfulPrompt(sessionState, typedFailureCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        sessionFailure: {
                            id: "failed-turn:error",
                            revision: 4,
                            phase: "cleared",
                        },
                    },
                },
            },
        });
        expect(sessionState.sessionFailure).toMatchObject({revision: 4, phase: "cleared"});
    });

    it("keeps one failure id across failed retry turns and clears it after recovery", async () => {
        const sessionState = createTestSessionState({
            sessionId: "retry-chain-session",
            account: {type: "apiKey"},
        });

        const first = await runPromptWithError(sessionState, {
            message: "first failure",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
        }, false, typedFailureCapabilities, "turn-1", false, "turn-1");
        const second = await runPromptWithError(sessionState, {
            message: "second failure",
            codexErrorInfo: "internalServerError",
            additionalDetails: null,
        }, false, typedFailureCapabilities, "turn-2", false, "turn-2");
        const recovered = await runSuccessfulPrompt(sessionState, typedFailureCapabilities, "turn-3");

        expect(first.result).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {id: "turn-1:error", revision: 1, phase: "active"}}}},
        });
        expect(second.result).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {
                id: "turn-1:error",
                revision: 2,
                phase: "active",
                turnId: "turn-2",
            }}}},
        });
        expect(first.updates).toEqual([]);
        expect(second.updates).toEqual([]);
        expect(recovered.updates[0]).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {id: "turn-1:error", revision: 3, phase: "cleared"}}}},
        });
    });

    it("publishes a typed failure when a failed completion has no error notification", async () => {
        const sessionState = createTestSessionState({
            sessionId: "failed-completion-session",
            account: {type: "apiKey"},
        });
        const {result, updates} = await runPromptWithCompletedTurn(
            sessionState,
            typedFailureCapabilities,
            createTurn("failed", "failed-turn", {
                message: "raw completion payload",
                codexErrorInfo: "serverOverloaded",
                additionalDetails: "secret completion details",
            }),
        );

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {
                id: "failed-turn:error",
                category: "overloaded",
                turnId: "failed-turn",
            }}}},
        });
        expect(updates).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("raw completion payload");
        expect(JSON.stringify(result)).not.toContain("secret completion details");
    });

    it("publishes a late idle error through the session-scoped subscription", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "idle-error-session",
            account: {type: "apiKey"},
        });
        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: typedFailureCapabilities,
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("inProgress", "completed-turn"),
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("completed", "completed-turn"),
        });

        await codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "finish before the late error"}],
        });
        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionState.sessionId,
                turnId: "completed-turn",
                willRetry: false,
                error: {
                    message: "raw late provider failure",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: "secret late details",
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionState.sessionId);

        const updates = mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update);
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        sessionFailure: {
                            id: expect.stringMatching(/^idle-error-session:error:[0-9a-f-]+$/),
                            revision: 1,
                            phase: "active",
                            category: "overloaded",
                            source: "codex",
                            safeMessage: "Codex is temporarily overloaded.",
                            retryable: true,
                            actions: ["retry"],
                        },
                    },
                },
            },
        }]);
        expect(JSON.stringify(updates)).not.toContain("raw late provider failure");
        expect(JSON.stringify(updates)).not.toContain("secret late details");
    });

    it("keeps a retrying late idle error diagnostic-only", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "idle-retry-session",
            account: {type: "apiKey"},
        });
        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: typedFailureCapabilities,
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
        vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: createTurn("inProgress", "completed-turn"),
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("completed", "completed-turn"),
        });
        await codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "finish before retry diagnostic"}],
        });
        mockFixture.clearAcpConnectionDump();

        mockFixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionState.sessionId,
                turnId: "completed-turn",
                willRetry: true,
                error: {
                    message: "raw retry detail",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: "secret retry detail",
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionState.sessionId);

        const updates = mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update);
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                codex: {
                    error: {
                        category: "overloaded",
                        message: "Codex is temporarily overloaded.",
                        turnId: "completed-turn",
                        willRetry: true,
                    },
                },
            },
        }]);
        expect(sessionState.sessionFailure).toBeUndefined();
        expect(JSON.stringify(updates)).not.toContain("raw retry detail");
        expect(JSON.stringify(updates)).not.toContain("secret retry detail");
    });

    it("drains a terminal error that arrives during a local slash command", async () => {
        const commandResult = deferred<CommandHandleResult>();
        const commandSpy = vi.spyOn(CodexCommands.prototype, "tryHandleCommand")
            .mockReturnValue(commandResult.promise);
        try {
            const mockFixture = createCodexMockTestFixture();
            const codexAcpAgent = mockFixture.getCodexAcpAgent();
            const sessionState = createTestSessionState({
                sessionId: "local-command-error-session",
                account: {type: "apiKey"},
            });
            await codexAcpAgent.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: typedFailureCapabilities,
            });
            vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

            const promptPromise = codexAcpAgent.prompt({
                sessionId: sessionState.sessionId,
                prompt: [{type: "text", text: "/status"}],
            });
            await vi.waitFor(() => expect(commandSpy).toHaveBeenCalled());
            mockFixture.sendServerNotification({
                method: "error",
                params: {
                    threadId: sessionState.sessionId,
                    turnId: "late-provider-turn",
                    willRetry: false,
                    error: {
                        message: "raw slash command failure",
                        codexErrorInfo: "serverOverloaded",
                        additionalDetails: "secret slash command detail",
                    },
                },
            });
            await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionState.sessionId);
            expect(sessionState.sessionFailure).toBeUndefined();

            commandResult.resolve({handled: true});
            await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});

            const updates = mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update);
            expect(updates).toEqual([{
                sessionUpdate: "session_info_update",
                _meta: {
                    jetbrains: {
                        air: {
                            version: 1,
                            sessionFailure: {
                                id: expect.stringMatching(/^local-command-error-session:error:[0-9a-f-]+$/),
                                revision: 1,
                                phase: "active",
                                category: "overloaded",
                                source: "codex",
                                safeMessage: "Codex is temporarily overloaded.",
                                retryable: true,
                                actions: ["retry"],
                            },
                        },
                    },
                },
            }]);
            expect(sessionState.sessionFailure).toMatchObject({phase: "active", revision: 1});
            expect(sessionState.sessionFailure).not.toHaveProperty("turnId");
            expect(JSON.stringify(updates)).not.toContain("raw slash command failure");
            expect(JSON.stringify(updates)).not.toContain("secret slash command detail");
        } finally {
            commandSpy.mockRestore();
        }
    });

    it("uses a new session-scoped failure id after recreating the consumer", async () => {
        const createFailureId = async (): Promise<string> => {
            const state = createTestSessionState({
                sessionId: "restored-session",
                account: {type: "apiKey"},
            });
            const updates: Array<{_meta?: Record<string, unknown>}> = [];
            const connection = {
                notify: vi.fn(async (_method: unknown, params: {update: {_meta?: Record<string, unknown>}}) => {
                    updates.push(params.update);
                }),
            } as unknown as AcpClientConnection;
            const handler = new CodexEventHandler(connection, state, false, true);
            await handler.handleSessionScopedNotification({
                method: "error",
                params: {
                    threadId: state.sessionId,
                    turnId: "old-turn",
                    willRetry: false,
                    error: {
                        message: "provider failed",
                        codexErrorInfo: "serverOverloaded",
                        additionalDetails: null,
                    },
                },
            });
            return (updates[0]!._meta as {
                jetbrains: {air: {sessionFailure: {id: string}}};
            }).jetbrains.air.sessionFailure.id;
        };

        const firstId = await createFailureId();
        const restartedId = await createFailureId();

        expect(firstId).toMatch(/^restored-session:error:[0-9a-f-]+$/);
        expect(restartedId).toMatch(/^restored-session:error:[0-9a-f-]+$/);
        expect(restartedId).not.toBe(firstId);
    });

    it("preserves negotiated prompt validation RequestErrors", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const sessionState = createTestSessionState({
            sessionId: "typed-validation-session",
            account: {type: "apiKey"},
            supportedInputModalities: ["text"],
        });
        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: typedFailureCapabilities,
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        await expect(codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "image", mimeType: "image/png", data: "AA=="}],
        })).rejects.toMatchObject({
            code: -32600,
        });
        expect(sessionState.sessionFailure).toBeUndefined();
    });

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
    clientCapabilities?: acp.ClientCapabilities,
    errorTurnId = "turn-id",
    errorBeforeTurnStarts = false,
    activeTurnId = "turn-id",
): Promise<{result: unknown; updates: unknown[]}> {
    const mockFixture = createCodexMockTestFixture();
    const codexAcpAgent = mockFixture.getCodexAcpAgent();
    const codexAppServerClient = mockFixture.getCodexAppServerClient();
    if (clientCapabilities) {
        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities,
        });
    }
    const turnStarted = deferred<{turn: ReturnType<typeof createTurn>}>();
    if (!errorBeforeTurnStarts) {
        turnStarted.resolve({turn: createTurn("inProgress", activeTurnId)});
    }
    const turnCompleted = deferred<TurnCompletedNotification>();
    const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockReturnValue(turnStarted.promise);
    vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockReturnValue(turnCompleted.promise);
    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

    const promptPromise = codexAcpAgent.prompt({
        sessionId: sessionState.sessionId,
        prompt: [{ type: "text", text: "test" }],
    });

    await vi.waitFor(() => {
        expect(turnStartSpy).toHaveBeenCalled();
    });

    const errorNotification = {
        method: "error",
        params: {
            threadId: sessionState.sessionId,
            turnId: errorTurnId,
            willRetry,
            error: turnError,
        },
    } as const;
    if (errorBeforeTurnStarts) {
        mockFixture.sendServerNotification(errorNotification);
        await new Promise(resolve => setImmediate(resolve));
        turnStarted.resolve({turn: createTurn("inProgress", activeTurnId)});
        await vi.waitFor(() => {
            expect(sessionState.currentTurnId).toBe(activeTurnId);
        });
    } else {
        mockFixture.sendServerNotification(errorNotification);
    }

    const completedNotification: TurnCompletedNotification = {
        threadId: sessionState.sessionId,
        turn: !willRetry && errorTurnId === activeTurnId
            ? createTurn("failed", activeTurnId, turnError)
            : createTurn("completed", activeTurnId),
    };
    mockFixture.sendServerNotification({method: "turn/completed", params: completedNotification});
    turnCompleted.resolve(completedNotification);

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

async function runSuccessfulPrompt(
    sessionState: SessionState,
    clientCapabilities: acp.ClientCapabilities,
    turnId = "turn-id",
): Promise<{result: unknown; updates: unknown[]}> {
    return runPromptWithCompletedTurn(sessionState, clientCapabilities, createTurn("completed", turnId));
}

async function runPromptWithCompletedTurn(
    sessionState: SessionState,
    clientCapabilities: acp.ClientCapabilities,
    completedTurn: ReturnType<typeof createTurn>,
): Promise<{result: unknown; updates: unknown[]}> {
    const mockFixture = createCodexMockTestFixture();
    const codexAcpAgent = mockFixture.getCodexAcpAgent();
    const codexAppServerClient = mockFixture.getCodexAppServerClient();
    await codexAcpAgent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities,
    });
    vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
        turn: createTurn("inProgress", completedTurn.id),
    });
    vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
        threadId: sessionState.sessionId,
        turn: completedTurn,
    });
    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

    let result: unknown;
    try {
        result = await codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "retry"}],
        });
    } catch (error) {
        result = error;
    }
    return {
        result,
        updates: mockFixture.getAcpConnectionEvents([]).map(event => event.args[0].update),
    };
}

function createTurn(
    status: "inProgress" | "completed" | "failed",
    id = "turn-id",
    error: ErrorNotification["error"] | null = null,
) {
    return {
        id,
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error,
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
