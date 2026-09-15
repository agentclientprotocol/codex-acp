import {beforeEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import {CodexCommands} from "../../CodexCommands";
import {logger} from "../../Logger";
import type {Turn, TurnCompletedNotification} from "../../app-server/v2";

function createTurn(id: string, status: Turn["status"]): Turn {
    return {
        id,
        items: [],
        itemsView: "notLoaded",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
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
        .mockResolvedValue({turn: createTurn("main-turn", "inProgress")});
    const awaitTurnCompleted = vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted")
        .mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("main-turn", "completed"),
        });
    return {fixture, sessionState, turnStart, awaitTurnCompleted};
}

describe("agent file-change report lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("advertises the AIR capability", async () => {
        const fixture = createCodexMockTestFixture();
        const response = await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
        });

        expect(response._meta).toMatchObject({
            jetbrains: {air: {version: 1, capabilities: expect.arrayContaining(["agentFileChangeReport"])}},
        });
    });

    it("publishes the final turn diff without starting a hidden fork or turn", async () => {
        const {fixture, sessionState, turnStart, awaitTurnCompleted} = await setupMainPrompt();
        const appServer = fixture.getCodexAppServerClient();
        awaitTurnCompleted.mockImplementationOnce(async (): Promise<TurnCompletedNotification> => {
            fixture.sendServerNotification({
                method: "turn/diff/updated",
                params: {
                    threadId: sessionState.sessionId,
                    turnId: "main-turn",
                    diff: "diff --git a/src/Main.kt b/src/Main.kt\n--- a/src/Main.kt\n+++ b/src/Main.kt\n@@ -1 +1 @@\n-old\n+new\n",
                },
            });
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });
        const fork = vi.spyOn(appServer, "threadFork");

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-42"),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(turnStart).toHaveBeenCalledOnce();
        expect(fork).not.toHaveBeenCalled();
        expect(reportedUpdates(fixture)).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {jetbrains: {air: {
                version: 1,
                agentFileChangeReport: {
                    version: 1,
                    requestId: "request-42",
                    status: "reported",
                    paths: ["/workspace/src/Main.kt"],
                    declaredComplete: false,
                    truncated: false,
                    uncertainty: "Codex turn diffs may omit changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes.",
                },
            }}},
        }]);
    });

    it("uses the latest aggregated snapshot instead of merging intermediate diffs", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt();
        awaitTurnCompleted.mockImplementationOnce(async () => {
            for (const [pathname, content] of [["first.txt", "first"], ["final.txt", "final"]]) {
                fixture.sendServerNotification({
                    method: "turn/diff/updated",
                    params: {
                        threadId: sessionState.sessionId,
                        turnId: "main-turn",
                        diff: `diff --git a/${pathname} b/${pathname}\n--- /dev/null\n+++ b/${pathname}\n@@ -0,0 +1 @@\n+${content}\n`,
                    },
                });
            }
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });

        await fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-latest"),
        );

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {paths: ["/workspace/final.txt"]}}}},
        });
    });

    it("reports an empty incomplete list when the turn emitted no diff", async () => {
        const {fixture, sessionState} = await setupMainPrompt();

        await fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-empty"),
        );

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "reported",
                paths: [],
                declaredComplete: false,
                truncated: false,
            }}}},
        });
    });

    it("reports an invalid turn diff as unavailable without failing the prompt", async () => {
        const {fixture, sessionState, awaitTurnCompleted} = await setupMainPrompt();
        awaitTurnCompleted.mockImplementationOnce(async () => {
            fixture.sendServerNotification({
                method: "turn/diff/updated",
                params: {threadId: sessionState.sessionId, turnId: "main-turn", diff: "invalid diff"},
            });
            return {threadId: sessionState.sessionId, turn: createTurn("main-turn", "completed")};
        });
        vi.spyOn(logger, "error").mockImplementation(() => {});

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-invalid"),
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                requestId: "request-invalid",
                status: "unavailable",
                reason: "invalidOutput",
            }}}},
        });
    });

    it("ignores the request when the capability was not negotiated", async () => {
        const {fixture, sessionState} = await setupMainPrompt(false);

        await fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-ignored"),
        );

        expect(reportedUpdates(fixture)).toEqual([]);
    });

    it("publishes cancelled when the prompt is cancelled before a turn", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const cancellation = new AbortController();
        cancellation.abort();

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-cancelled"),
            cancellation.signal,
        )).resolves.toMatchObject({stopReason: "cancelled"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "cancelled",
            }}}},
        });
    });

    it("publishes cancelled when cancellation arrives after the provider turn completes", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const cancellation = new AbortController();
        sessionState.titleGen = {
            onTurnCompleted: () => cancellation.abort(),
        } as unknown as NonNullable<SessionState["titleGen"]>;

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-late-cancel"),
            cancellation.signal,
        )).resolves.toMatchObject({stopReason: "end_turn"});

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "cancelled",
            }}}},
        });
    });

    it("publishes notReported for a local command without a provider turn", async () => {
        const {fixture, sessionState} = await setupMainPrompt();
        const command = vi.spyOn(CodexCommands.prototype, "tryHandleCommand")
            .mockResolvedValue({handled: true});
        try {
            await fixture.getCodexAcpAgent().prompt(
                promptWithFileChangeReport(sessionState.sessionId, "request-local", "/status"),
            );
        } finally {
            command.mockRestore();
        }

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "notReported",
            }}}},
        });
    });

    it("publishes providerError when the provider turn fails to start", async () => {
        const {fixture, sessionState, turnStart} = await setupMainPrompt();
        turnStart.mockReset();
        turnStart.mockRejectedValue(new Error("provider failed"));
        vi.spyOn(logger, "error").mockImplementation(() => {});

        await expect(fixture.getCodexAcpAgent().prompt(
            promptWithFileChangeReport(sessionState.sessionId, "request-provider-error"),
        )).rejects.toThrow("provider failed");

        expect(reportedUpdates(fixture)[0]).toMatchObject({
            _meta: {jetbrains: {air: {agentFileChangeReport: {
                status: "unavailable",
                reason: "providerError",
            }}}},
        });
    });
});
