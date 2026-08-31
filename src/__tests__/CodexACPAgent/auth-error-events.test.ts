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
            message: "Codex is temporarily overloaded.",
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
                            category: "service",
                            severity: "error",
                            title: "Codex is temporarily overloaded.",
                            actions: ["retry"],
                        },
                    },
                },
            },
        });
        expect(JSON.stringify(result)).not.toContain("secret raw details");
        expect(updates).toEqual([]);

        const wire = JSON.parse(JSON.stringify({jsonrpc: "2.0", id: 1, result}));
        expect(wire.result._meta.jetbrains.air.sessionFailure).toEqual(
            expect.objectContaining({id: "turn-id:error", category: "service"}),
        );
    });

    it("does not attach a foreign turn failure to the active prompt", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "foreign-turn-session",
            account: { type: "apiKey" },
        }), {
            message: "Codex could not complete the previous turn.",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: "secret foreign-turn details",
        }, false, typedFailureCapabilities, "foreign-turn");

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("secret foreign-turn details");
        expect(updates).toEqual([expect.objectContaining({
            sessionUpdate: "session_info_update",
            _meta: {jetbrains: {air: expect.objectContaining({sessionFailure: expect.objectContaining({
                id: "foreign-turn:error",
                category: "service",
                severity: "error",
            })})}},
        })]);
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
        expect(updates).toEqual([expect.objectContaining({
            sessionUpdate: "session_info_update",
            _meta: {jetbrains: {air: expect.objectContaining({sessionFailure: expect.objectContaining({
                id: "foreign-turn:error",
                category: "service",
            })})}},
        })]);
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
            _meta: {jetbrains: {air: {sessionFailure: {id: "turn-id:error", category: "service"}}}},
        });
        expect(updates).toEqual([]);
        const logText = JSON.stringify(log.mock.calls);
        expect(logText).toContain("Buffered app-server error");
        expect(logText).not.toContain("current turn failed early");
        log.mockRestore();
    });

    it("publishes an inline warning while Codex will retry", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "typed-retrying-session",
            account: { type: "apiKey" },
        }), {
            message: "Reconnecting... 1/5",
            codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: null}},
            additionalDetails: "secret retry details",
        }, true, typedFailureCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("secret retry details");
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        sessionFailure: {
                            id: "turn-id:error",
                            revision: 1,
                            category: "connection",
                            severity: "warning",
                            title: "Reconnecting... 1/5",
                            actions: [],
                        },
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
            message: "Rate limit reached. Please try again later.",
            codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: 429}},
            additionalDetails: "secret rate-limit details",
        }, true, typedFailureCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(JSON.stringify(updates)).not.toContain("secret rate-limit details");
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        sessionFailure: {
                            id: "turn-id:error",
                            revision: 1,
                            category: "limit",
                            severity: "warning",
                            title: "Rate limit reached. Please try again later.",
                            actions: [],
                        },
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
            message: "Authentication required",
            codexErrorInfo: "unauthorized",
            additionalDetails: "secret authentication details",
        }, false, typedFailureCapabilities);

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {category: "access"}}}},
        });
        expect(JSON.stringify(result)).not.toContain("secret authentication details");
        expect(updates).toEqual([]);
    });

    it("accepts a newer additive typed-failure capability version", async () => {
        const {result, updates} = await runPromptWithError(createTestSessionState({
            sessionId: "newer-capability-session",
            account: { type: "apiKey" },
        }), {
            message: "Codex is temporarily overloaded.",
            codexErrorInfo: "serverOverloaded",
            additionalDetails: null,
        }, false, {_meta: {jetbrains: {air: {version: 2, capabilities: ["sessionFailure"]}}}});

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {version: 1, sessionFailure: {category: "service"}}}},
        });
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
        ["connection", {responseStreamDisconnected: {httpStatusCode: 503}}],
        ["access", "unauthorized"],
        ["limit", {responseStreamDisconnected: {httpStatusCode: 429}}],
        ["limit", "usageLimitExceeded"],
        ["service", "serverOverloaded"],
        ["limit", "contextWindowExceeded"],
        ["limit", "sessionBudgetExceeded"],
        ["request", "cyberPolicy"],
        ["request", "badRequest"],
        ["service", "internalServerError"],
        ["service", "threadRollbackFailed"],
        ["service", "sandboxError"],
        ["service", "other"],
        ["connection", {httpConnectionFailed: {httpStatusCode: null}}],
        ["connection", {responseStreamConnectionFailed: {httpStatusCode: 503}}],
        ["connection", {responseTooManyFailedAttempts: {httpStatusCode: 503}}],
        ["service", {activeTurnNotSteerable: {turnKind: "review"}}],
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

    it("keeps a historical failure and clears only producer runtime state after recovery", async () => {
        const sessionState = createTestSessionState({
            sessionId: "recovered-session",
            account: { type: "apiKey" },
            sessionFailure: {
                id: "failed-turn:error",
                revision: 3,
                category: "service",
                severity: "error",
                title: "Codex is temporarily overloaded.",
                actions: ["retry"],
            },
        });

        const {result, updates} = await runSuccessfulPrompt(sessionState, typedFailureCapabilities);

        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(updates).toEqual([]);
        expect(sessionState.sessionFailure).toBeUndefined();
    });

    it("uses a new failure id for each failed turn", async () => {
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
            _meta: {jetbrains: {air: {sessionFailure: {id: "turn-1:error", revision: 1}}}},
        });
        expect(second.result).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {
                id: "turn-2:error",
                revision: 1,
            }}}},
        });
        expect(first.updates).toEqual([]);
        expect(second.updates).toEqual([]);
        expect(recovered.updates).toEqual([]);
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
                message: "Codex is temporarily overloaded.",
                codexErrorInfo: "serverOverloaded",
                additionalDetails: "secret completion details",
            }),
        );

        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {
                id: "failed-turn:error",
                category: "service",
            }}}},
        });
        expect(updates).toEqual([]);
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
                    message: "Codex is temporarily overloaded.",
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
                            id: "completed-turn:error",
                            revision: 1,
                            category: "service",
                            severity: "error",
                            title: "Codex is temporarily overloaded.",
                            actions: ["retry"],
                        },
                    },
                },
            },
        }]);
        expect(JSON.stringify(updates)).not.toContain("secret late details");
    });

    it("publishes a retrying late idle error as a typed warning", async () => {
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
                    message: "Reconnecting... 1/5",
                    codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: null}},
                    additionalDetails: "secret retry detail",
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
                            id: "completed-turn:error",
                            revision: 1,
                            category: "connection",
                            severity: "warning",
                            title: "Reconnecting... 1/5",
                            actions: [],
                        },
                    },
                },
            },
        }]);
        expect(sessionState.sessionFailure).toMatchObject({id: "completed-turn:error", severity: "warning"});
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
                        message: "Codex is temporarily overloaded.",
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
                                id: "late-provider-turn:error",
                                revision: 1,
                                category: "service",
                                severity: "error",
                                title: "Codex is temporarily overloaded.",
                                actions: ["retry"],
                            },
                        },
                    },
                },
            }]);
            expect(sessionState.sessionFailure).toMatchObject({severity: "error", revision: 1});
            expect(JSON.stringify(updates)).not.toContain("secret slash command detail");
        } finally {
            commandSpy.mockRestore();
        }
    });

    it("preserves provider turn identity after recreating the consumer", async () => {
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

        expect(firstId).toBe("old-turn:error");
        expect(restartedId).toBe(firstId);
    });

    it("does not recommend a new session for an exhausted account usage quota", async () => {
        const {result} = await runPromptWithError(createTestSessionState({
            sessionId: "usage-quota-actions-session",
            account: {type: "apiKey"},
        }), {
            message: "You have no usage left.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
        }, false, typedFailureCapabilities);

        expect(result).toMatchObject({
            _meta: {jetbrains: {air: {sessionFailure: {category: "limit", actions: []}}}},
        });
    });

    it("starts a new incident when turn output proves a retry warning recovered", async () => {
        const state = createTestSessionState({
            sessionId: "two-reconnect-incidents",
            currentTurnId: "turn-id",
            account: {type: "apiKey"},
        });
        const updates: Array<{_meta?: Record<string, unknown>}> = [];
        const connection = {
            notify: vi.fn(async (_method: unknown, params: {update: {_meta?: Record<string, unknown>}}) => {
                updates.push(params.update);
            }),
        } as unknown as AcpClientConnection;
        const handler = new CodexEventHandler(connection, state, false, true, "test-epoch");
        const retryError = (message: string) => ({
            method: "error" as const,
            params: {
                threadId: state.sessionId,
                turnId: "turn-id",
                willRetry: true,
                error: {
                    message,
                    codexErrorInfo: {responseStreamDisconnected: {httpStatusCode: null}},
                    additionalDetails: null,
                },
            },
        });

        await handler.handleNotification(retryError("First reconnect incident"));
        await handler.handleNotification({
            method: "item/agentMessage/delta",
            params: {threadId: state.sessionId, turnId: "turn-id", itemId: "message", delta: "Recovered."},
        });
        await handler.handleNotification(retryError("Second reconnect incident"));

        const failures = updates.flatMap(update => {
            const air = (update._meta as {jetbrains?: {air?: {sessionFailure?: {id: string; revision: number}}}} | undefined)
                ?.jetbrains?.air;
            return air?.sessionFailure === undefined ? [] : [air.sessionFailure];
        });
        expect(failures).toHaveLength(2);
        expect(failures[0]).toEqual(expect.objectContaining({id: "turn-id:error", revision: 1}));
        expect(failures[1]).toEqual(expect.objectContaining({revision: 1}));
        expect(failures[1]!.id).not.toBe(failures[0]!.id);
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
