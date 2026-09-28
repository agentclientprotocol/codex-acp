import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import type {CodexAcpClient} from "../../CodexAcpClient";
import type {TurnCompletedNotification} from "../../app-server/v2";

const sessionId = "session-id";
const turnId = "turn-id";

// Codex answers this both for a turn that already finished and for one it has
// not registered as interruptible yet.
const NO_ACTIVE_TURN = new Error("no active turn to interrupt");

describe("session/cancel racing Codex's turn registration", () => {
    it("retries the interrupt until Codex accepts it", async () => {
        const turn = await startPrompt();
        const turnInterrupt = vi.spyOn(turn.codexAcpClient, "turnInterrupt")
            .mockRejectedValueOnce(NO_ACTIVE_TURN)
            .mockRejectedValueOnce(NO_ACTIVE_TURN)
            .mockResolvedValueOnce(undefined);

        await turn.codexAcpAgent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledTimes(3);
        expect(turnInterrupt).toHaveBeenLastCalledWith({threadId: sessionId, turnId});
        await turn.finish();
    });

    it("gives up after the retry budget instead of spinning", async () => {
        const turn = await startPrompt();
        const turnInterrupt = vi.spyOn(turn.codexAcpClient, "turnInterrupt")
            .mockRejectedValue(NO_ACTIVE_TURN);

        await turn.codexAcpAgent.cancel({sessionId});

        // One initial attempt plus one per configured backoff step.
        expect(turnInterrupt).toHaveBeenCalledTimes(6);
        await turn.finish();
    });

    it("does not retry an interrupt that failed for another reason", async () => {
        const turn = await startPrompt();
        const turnInterrupt = vi.spyOn(turn.codexAcpClient, "turnInterrupt")
            .mockRejectedValue(new Error("codex app-server transport closed"));

        await turn.codexAcpAgent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledTimes(1);
        await turn.finish();
    });

    it("retries a close interrupt the same way as a cancel", async () => {
        const turn = await startPrompt();
        const turnInterrupt = vi.spyOn(turn.codexAcpClient, "turnInterrupt")
            .mockRejectedValueOnce(NO_ACTIVE_TURN)
            .mockRejectedValueOnce(NO_ACTIVE_TURN)
            .mockResolvedValueOnce(undefined);

        const closed = turn.codexAcpAgent.closeSession({sessionId});
        // The turn is still active while the retries run: only resolve it once
        // `turnInterrupt` has gone through its retry budget, otherwise the underlying
        // prompt would complete and drop the session from the active-prompts set first.
        await vi.waitFor(() => expect(turnInterrupt).toHaveBeenCalledTimes(3));
        await turn.finish();
        await closed;

        expect(turnInterrupt).toHaveBeenCalledTimes(3);
        expect(turnInterrupt).toHaveBeenLastCalledWith({threadId: sessionId, turnId});
    });
});

/**
 * Creates a session and leaves one prompt turn in flight -- the state a
 * `session/cancel` actually arrives in.
 */
async function startPrompt(): Promise<{
    codexAcpAgent: CodexAcpServer,
    codexAcpClient: CodexAcpClient,
    finish: () => Promise<void>,
}> {
    const fixture: CodexMockTestFixture = createCodexMockTestFixture();
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId,
        currentModelId: "model-id[medium]",
        models: [createTestModel()],
        collaborationMode: "default",
        currentServiceTier: null,
        additionalDirectories: [],
    });
    await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});

    const inProgressTurn = {
        id: turnId,
        items: [],
        itemsView: "notLoaded" as const,
        status: "inProgress" as const,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
    vi.spyOn(appServer, "turnStart").mockResolvedValue({turn: inProgressTurn});
    let completeTurn: (value: TurnCompletedNotification) => void = () => {};
    vi.spyOn(appServer, "awaitTurnCompleted").mockReturnValue(
        new Promise<TurnCompletedNotification>(resolve => {
            completeTurn = resolve;
        })
    );

    const prompt = codexAcpAgent.prompt({sessionId, prompt: [{type: "text", text: "hello"}]});
    await vi.waitFor(() => {
        expect(codexAcpAgent.getSessionState(sessionId).currentTurnId).toBe(turnId);
    });

    return {
        codexAcpAgent,
        codexAcpClient,
        finish: async () => {
            completeTurn({
                threadId: sessionId,
                turn: {...inProgressTurn, status: "interrupted"},
            });
            await prompt;
        },
    };
}
