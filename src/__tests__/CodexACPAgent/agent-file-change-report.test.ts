import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import {
    AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA,
    AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS,
} from "../../AgentFileChangeReport";
import {CodexCommands} from "../../CodexCommands";
import {logger} from "../../Logger";
import type {
    ThreadForkResponse,
    Turn,
    TurnCompletedNotification,
} from "../../app-server/v2";

function createTurn(
    id: string,
    status: Turn["status"],
    items: Turn["items"] = [],
    itemsView: Turn["itemsView"] = "notLoaded",
): Turn {
    return {
        id,
        items,
        itemsView,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function createForkResponse(threadId: string): ThreadForkResponse {
    return {thread: {id: threadId}} as ThreadForkResponse;
}

function promptWithFileChangeReport(
    sessionId: string,
    requestId: string,
    text = "make the change",
): acp.PromptRequest {
    return {
        sessionId,
        prompt: [{type: "text", text}],
        _meta: {
            jetbrains: {
                air: {
                    agentFileChangeReportRequest: {version: 1, requestId},
                },
            },
        },
    };
}

function reportedUpdates(fixture: CodexMockTestFixture): unknown[] {
    return fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0].update)
        .filter(update => update.sessionUpdate === "session_info_update"
            && update._meta?.jetbrains?.air?.agentFileChangeReport !== undefined);
}

const FILE_CHANGE_REPORT_CLIENT_CAPABILITIES: acp.ClientCapabilities = {
    _meta: {
        jetbrains: {
            air: {
                version: 1,
                capabilities: ["agentFileChangeReport"],
            },
        },
    },
};

async function setupMainPrompt(negotiateCapability = true): Promise<{
    fixture: CodexMockTestFixture;
    sessionState: SessionState;
    turnStart: ReturnType<typeof vi.spyOn>;
    awaitTurnCompleted: ReturnType<typeof vi.spyOn>;
}> {
    const fixture = createCodexMockTestFixture();
    await fixture.getCodexAcpAgent().initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        ...(negotiateCapability ? {clientCapabilities: FILE_CHANGE_REPORT_CLIENT_CAPABILITIES} : {}),
    });
    const sessionState = createTestSessionState({
        cwd: "/workspace",
        additionalDirectories: ["/generated"],
    });
    vi.spyOn(fixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    const turnStart = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart")
        .mockResolvedValueOnce({turn: createTurn("main-turn", "inProgress")});
    const awaitTurnCompleted = vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted")
        .mockResolvedValueOnce({
            threadId: sessionState.sessionId,
            turn: createTurn("main-turn", "completed"),
        });
    return {fixture, sessionState, turnStart, awaitTurnCompleted};
}

describe("agent file-change report lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("advertises the AIR capability", async () => {
        const fixture = createCodexMockTestFixture();

        const response = await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
        });

        expect(response._meta).toMatchObject({
            jetbrains: {
                air: {
                    version: 1,
                    capabilities: expect.arrayContaining(["agentFileChangeReport"]),
                },
            },
        });
    });

    it("runs a hidden read-only fork and publishes one correlated report", async () => {
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadFork").mockResolvedValue(createForkResponse("audit-thread"));
        turnStart.mockResolvedValueOnce({turn: createTurn("audit-turn", "inProgress")});
        awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
            fixture.sendServerNotification({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "audit-thread",
                    turnId: "audit-turn",
                    itemId: "audit-message",
                    delta: "this must stay hidden",
                },
            });
            return {
                threadId: "audit-thread",
                turn: createTurn("audit-turn", "completed", [{
                    type: "agentMessage",
                    id: "audit-message",
                    text: JSON.stringify({
                        paths: ["src/Main.kt", "/generated/output.txt"],
                        complete: true,
                        uncertainty: null,
                    }),
                    phase: "final_answer",
                    memoryCitation: null,
                    delivery: null,
                }], "full"),
            };
        });
        const threadRead = vi.spyOn(appServer, "threadRead");
        const unsubscribe = vi.spyOn(appServer, "threadUnsubscribe")
            .mockResolvedValue({status: "unsubscribed"});

        await expect(fixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "make the change"}],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: {version: 1, requestId: "request-42"},
                    },
                },
            },
        })).resolves.toMatchObject({stopReason: "end_turn"});

        expect(appServer.threadFork).toHaveBeenCalledWith({
            threadId: sessionState.sessionId,
            lastTurnId: "main-turn",
            cwd: "/workspace",
            approvalPolicy: "never",
            sandbox: "read-only",
            developerInstructions: expect.any(String),
            ephemeral: true,
        });
        expect(turnStart).toHaveBeenNthCalledWith(2, {
            threadId: "audit-thread",
            input: [{type: "text", text: expect.any(String), text_elements: []}],
            cwd: "/workspace",
            approvalPolicy: "never",
            sandboxPolicy: {type: "readOnly", networkAccess: false},
            summary: "none",
            outputSchema: AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA,
        });
        expect(threadRead).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledWith({threadId: "audit-thread"});

        const acpEvents = fixture.getAcpConnectionEvents([]);
        expect(acpEvents).toEqual([{
            method: "sessionUpdate",
            args: [{
                sessionId: sessionState.sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    _meta: {
                        jetbrains: {
                            air: {
                                version: 1,
                                agentFileChangeReport: {
                                    version: 1,
                                    requestId: "request-42",
                                    status: "reported",
                                    paths: ["/workspace/src/Main.kt", "/generated/output.txt"],
                                    declaredComplete: true,
                                    truncated: false,
                                },
                            },
                        },
                    },
                },
            }],
        }]);
    });

    it("does not fork for absent or malformed opt-in metadata", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const fork = vi.spyOn(fixture.getCodexAppServerClient(), "threadFork");

        await expect(fixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "ordinary prompt"}],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: {version: 1, requestId: "invalid id"},
                    },
                },
            },
        })).resolves.toMatchObject({stopReason: "end_turn"});

        expect(fork).not.toHaveBeenCalled();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("ignores a valid request when the client did not negotiate the capability", async () => {
        const {fixture, sessionState} = await setupMainPrompt(false);
        const fork = vi.spyOn(fixture.getCodexAppServerClient(), "threadFork");

        await expect(fixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "ordinary prompt"}],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: {version: 1, requestId: "request-44"},
                    },
                },
            },
        })).resolves.toMatchObject({stopReason: "end_turn"});

        expect(fork).not.toHaveBeenCalled();
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("keeps the completed main prompt successful when the hidden audit is cancelled", async () => {
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadFork").mockResolvedValue(createForkResponse("audit-thread"));
        turnStart.mockResolvedValueOnce({turn: createTurn("audit-turn", "inProgress")});
        awaitTurnCompleted.mockReturnValueOnce(new Promise(() => {}));
        vi.spyOn(appServer, "turnInterrupt").mockResolvedValue({});
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
        const cancellation = new AbortController();

        const prompt = fixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "make the change"}],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: {version: 1, requestId: "request-cancelled"},
                    },
                },
            },
        }, cancellation.signal);
        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(2));
        cancellation.abort();

        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
        expect(fixture.getAcpConnectionEvents([])).toEqual([{
            method: "sessionUpdate",
            args: [{
                sessionId: sessionState.sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    _meta: {
                        jetbrains: {
                            air: {
                                version: 1,
                                agentFileChangeReport: {
                                    version: 1,
                                    requestId: "request-cancelled",
                                    status: "unavailable",
                                    reason: "cancelled",
                                },
                            },
                        },
                    },
                },
            }],
        }]);
    });

    it("publishes cancelled once when the prompt ends before a turn starts", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        const fork = vi.spyOn(appServer, "threadFork");
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-early-cancel"),
            cancellation.signal,
        )).resolves.toMatchObject({stopReason: "cancelled"});

        expect(fork).not.toHaveBeenCalled();
        expect(reportedUpdates(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        agentFileChangeReport: {
                            version: 1,
                            requestId: "request-early-cancel",
                            status: "unavailable",
                            reason: "cancelled",
                        },
                    },
                },
            },
        }]);
    });

    it("publishes notReported once for a local command without a provider turn", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const command = vi.spyOn(CodexCommands.prototype, "tryHandleCommand")
            .mockResolvedValue({handled: true});
        const fork = vi.spyOn(fixture.getCodexAppServerClient(), "threadFork");
        try {
            await expect(fixture.getCodexAcpAgent().prompt(
                promptWithFileChangeReport(sessionState.sessionId, "request-local", "/status"),
            )).resolves.toMatchObject({stopReason: "end_turn"});
        } finally {
            command.mockRestore();
        }

        expect(fork).not.toHaveBeenCalled();
        expect(reportedUpdates(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        agentFileChangeReport: {
                            version: 1,
                            requestId: "request-local",
                            status: "unavailable",
                            reason: "notReported",
                        },
                    },
                },
            },
        }]);
    });

    it("publishes providerError once when the provider turn fails", async () => {
        const {fixture, sessionState, turnStart} = await setupMainPrompt();
        turnStart.mockReset();
        turnStart.mockRejectedValue(new Error("provider failed"));
        const fork = vi.spyOn(fixture.getCodexAppServerClient(), "threadFork");

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-provider-error"),
        )).rejects.toThrow("provider failed");

        expect(fork).not.toHaveBeenCalled();
        expect(reportedUpdates(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        agentFileChangeReport: {
                            version: 1,
                            requestId: "request-provider-error",
                            status: "unavailable",
                            reason: "providerError",
                        },
                    },
                },
            },
        }]);
    });

    it("bounds a stuck fork with the shared audit deadline", async () => {
        vi.useFakeTimers();
        const {fixture, sessionState} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        const fork = vi.spyOn(appServer, "threadFork").mockReturnValue(new Promise(() => {}));

        const prompt = fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-fork-timeout"),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(fork).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS);

        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
        expect(reportedUpdates(fixture)).toHaveLength(1);
        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                requestId: "request-fork-timeout",
                status: "unavailable",
                reason: "timeout",
            }}}},
        });
    });

    it("does not wait past the shared deadline for interrupt or unsubscribe", async () => {
        vi.useFakeTimers();
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadFork").mockResolvedValue(createForkResponse("audit-thread"));
        turnStart.mockResolvedValueOnce({turn: createTurn("audit-turn", "inProgress")});
        awaitTurnCompleted.mockReturnValueOnce(new Promise(() => {}));
        const interrupt = vi.spyOn(appServer, "turnInterrupt").mockReturnValue(new Promise(() => {}));
        const unsubscribe = vi.spyOn(appServer, "threadUnsubscribe").mockReturnValue(new Promise(() => {}));

        const prompt = fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-cleanup-timeout"),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(turnStart).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS);

        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
        expect(interrupt).toHaveBeenCalledWith({threadId: "audit-thread", turnId: "audit-turn"});
        expect(unsubscribe).toHaveBeenCalledWith({threadId: "audit-thread"});
        expect(reportedUpdates(fixture)).toHaveLength(1);
        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                requestId: "request-cleanup-timeout",
                status: "unavailable",
                reason: "timeout",
            }}}},
        });
    });

    it("reports a failed audit turn with the provider error without failing the main prompt", async () => {
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadFork").mockResolvedValue(createForkResponse("audit-thread"));
        turnStart.mockResolvedValueOnce({turn: createTurn("audit-turn", "inProgress")});
        const failedTurn = createTurn("audit-turn", "failed");
        failedTurn.error = {
            message: "invalid_json_schema: missing uncertainty",
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
        };
        awaitTurnCompleted.mockResolvedValueOnce({
            threadId: "audit-thread",
            turn: failedTurn,
        });
        const read = vi.spyOn(appServer, "threadRead");
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});
        const logError = vi.spyOn(logger, "error").mockImplementation(() => {});

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-read-timeout"),
        )).resolves.toMatchObject({stopReason: "end_turn"});
        expect(read).not.toHaveBeenCalled();
        expect(logError).toHaveBeenCalledWith(
            "Agent file-change report unavailable",
            expect.objectContaining({
                reason: "providerError",
                message: "The audit turn failed: invalid_json_schema: missing uncertainty",
            }),
        );
        expect(reportedUpdates(fixture)).toHaveLength(1);
        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                requestId: "request-read-timeout",
                status: "unavailable",
                reason: "providerError",
            }}}},
        });
    });

    it("reports invalid audit output as unavailable without failing the prompt", async () => {
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadFork").mockResolvedValue(createForkResponse("audit-thread"));
        turnStart.mockResolvedValueOnce({turn: createTurn("audit-turn", "inProgress")});
        awaitTurnCompleted.mockResolvedValueOnce({
            threadId: "audit-thread",
            turn: createTurn("audit-turn", "completed", [{
                type: "agentMessage",
                id: "audit-message",
                text: "not JSON",
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
            }], "full"),
        });
        const threadRead = vi.spyOn(appServer, "threadRead");
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({status: "unsubscribed"});

        await expect(fixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "make the change"}],
            _meta: {
                jetbrains: {
                    air: {
                        agentFileChangeReportRequest: {version: 1, requestId: "request-43"},
                    },
                },
            },
        })).resolves.toMatchObject({stopReason: "end_turn"});

        expect(threadRead).not.toHaveBeenCalled();

        expect(fixture.getAcpConnectionEvents([])).toEqual([{
            method: "sessionUpdate",
            args: [{
                sessionId: sessionState.sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    _meta: {
                        jetbrains: {
                            air: {
                                version: 1,
                                agentFileChangeReport: {
                                    version: 1,
                                    requestId: "request-43",
                                    status: "unavailable",
                                    reason: "invalidOutput",
                                },
                            },
                        },
                    },
                },
            }],
        }]);
    });
});
