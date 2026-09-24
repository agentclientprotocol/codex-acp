import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type {ServerNotification} from "../../app-server";
import type {ErrorNotification, ReviewStartResponse} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestModel, type CodexMockTestFixture} from "../acp-test-utils";
import type {CodexAcpServer, SessionState} from "../../CodexAcpServer";

// Codex answers `review/start` with the parent turn id and reports the review's items, errors and
// completion under it, but starts (and only accepts `turn/interrupt` for) a reviewer child turn.
const sessionId = "session-id";
const parentTurnId = "review-parent-turn";
const childTurnId = "review-child-turn";

const typedFailureCapabilities: acp.ClientCapabilities = {
    _meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}},
};

const overloadedError: ErrorNotification["error"] = {
    message: "Codex is temporarily overloaded.",
    codexErrorInfo: "serverOverloaded",
    additionalDetails: null,
    misalignment: null,
};

const notGitRepositoryError: ErrorNotification["error"] = {
    message: "/test/cwd is not a git repository",
    codexErrorInfo: null,
    additionalDetails: null,
    misalignment: null,
};

describe("/review turn ids", () => {
    it("tracks the parent id as the review turn and the child id as the interruptible one", async () => {
        const review = await startReview();
        expect(review.sessionState.currentTurnId).toBe(parentTurnId);
        expect(review.sessionState.interruptTurnId).toBe(childTurnId);

        review.send(agentMessageDelta("Looks good."));
        review.send(turnCompleted("completed"));

        const result = await review.prompt;
        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(review.sessionState.currentTurnId).toBeNull();
        expect(review.sessionState.interruptTurnId).toBeNull();
        await expect(review.dump(result)).toMatchFileSnapshot("data/review-turn-completed.json");
    });

    it("surfaces a review error as agent text, like a normal turn's error", async () => {
        const review = await startReview();

        review.send(error(overloadedError));
        review.send(turnCompleted("failed", overloadedError));

        const result = await review.prompt;
        expect(result).toMatchObject({stopReason: "end_turn"});
        await expect(review.dump(result)).toMatchFileSnapshot("data/review-turn-error.json");
    });

    it("fails the review prompt on a usage limit error", async () => {
        const usageLimitError: ErrorNotification["error"] = {
            message: "Usage limits were exceeded",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
            misalignment: null,
        };
        const review = await startReview();

        review.send(error(usageLimitError));
        review.send(turnCompleted("failed", usageLimitError));

        const failure = await review.prompt.then(() => null, (err: unknown) => err);
        expect(failure).toBeInstanceOf(acp.RequestError);
        expect(failure).toMatchObject({data: {message: "Usage limits were exceeded", codexErrorInfo: "usageLimitExceeded"}});
    });

    it("returns a typed review failure once, on the prompt response only", async () => {
        const review = await startReview(typedFailureCapabilities);

        review.send(error(overloadedError));
        review.send(turnCompleted("failed", overloadedError));

        const result = await review.prompt;
        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {
                id: `${parentTurnId}:error`,
                category: "service",
                severity: "error",
                title: "Codex is temporarily overloaded.",
            }}}},
        });
        // The terminal failure is not also published as a live session update.
        await expect(review.dump(result)).toMatchFileSnapshot("data/review-turn-typed-failure.json");
    });

    it("interrupts the child turn on session/cancel", async () => {
        const review = await startReview();
        const turnInterrupt = vi.spyOn(review.fixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async () => {
                review.send(turnCompleted("interrupted"));
            });

        await review.agent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: childTurnId});
        await expect(review.prompt).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it("interrupts the child turn when the prompt request is cancelled", async () => {
        const controller = new AbortController();
        const review = await startReview(undefined, controller.signal);
        const turnInterrupt = vi.spyOn(review.fixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async () => {
                review.send(turnCompleted("interrupted"));
            });

        controller.abort();

        await expect(review.prompt).resolves.toMatchObject({stopReason: "cancelled"});
        await vi.waitFor(() => {
            expect(turnInterrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: childTurnId});
        });
    });

    it("interrupts with the review/start id until the child turn has started", async () => {
        const review = await startReview(undefined, undefined, false);
        const turnInterrupt = vi.spyOn(review.fixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async () => {
                review.send(turnCompleted("interrupted"));
            });

        await review.agent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: parentTurnId});
        await expect(review.prompt).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it("recomputes the turn id between retries once the child turn starts", async () => {
        vi.useFakeTimers();
        try {
            const review = await startReview(undefined, undefined, false);
            const turnInterrupt = vi.spyOn(review.fixture.getCodexAcpClient(), "turnInterrupt")
                .mockRejectedValueOnce(new Error("no active turn to interrupt"))
                .mockImplementationOnce(async () => {
                    review.send(turnCompleted("interrupted"));
                });

            const cancelPromise = review.agent.cancel({sessionId});
            await vi.advanceTimersByTimeAsync(0);
            expect(turnInterrupt).toHaveBeenCalledTimes(1);
            expect(turnInterrupt).toHaveBeenNthCalledWith(1, {threadId: sessionId, turnId: parentTurnId});

            // The child turn registers between the first (rejected) attempt and the retry.
            review.send({method: "turn/started", params: {threadId: sessionId, turn: turn(childTurnId, "inProgress")}});
            await review.fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

            await vi.advanceTimersByTimeAsync(25);
            await cancelPromise;
            expect(turnInterrupt).toHaveBeenCalledTimes(2);
            expect(turnInterrupt).toHaveBeenNthCalledWith(2, {threadId: sessionId, turnId: childTurnId});
            await expect(review.prompt).resolves.toMatchObject({stopReason: "cancelled"});
        } finally {
            vi.useRealTimers();
        }
    });

    it("retries with the turn id Codex reports as active on an 'expected active turn id' mismatch", async () => {
        const review = await startReview(undefined, undefined, false);
        const turnInterrupt = vi.spyOn(review.fixture.getCodexAcpClient(), "turnInterrupt")
            .mockRejectedValueOnce(new Error(`expected active turn id ${parentTurnId} but found ${childTurnId}`))
            .mockImplementationOnce(async () => {
                review.send(turnCompleted("interrupted"));
            });

        await review.agent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledTimes(2);
        expect(turnInterrupt).toHaveBeenNthCalledWith(1, {threadId: sessionId, turnId: parentTurnId});
        expect(turnInterrupt).toHaveBeenNthCalledWith(2, {threadId: sessionId, turnId: childTurnId});
        await expect(review.prompt).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it("does not retry an 'expected active turn id' mismatch for a stale (already-completed) turn", async () => {
        const review = await startReview();
        const turnInterrupt = vi.spyOn(review.fixture.getCodexAcpClient(), "turnInterrupt")
            .mockRejectedValueOnce(new Error("expected active turn id some-other-turn but found unrelated-turn"));

        await review.agent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledTimes(1);
        review.send(turnCompleted("completed"));
        await expect(review.prompt).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("ends the review prompt when Codex fails before starting the review", async () => {
        const review = await startReview(undefined, undefined, false, false);

        // Codex sends nothing after this error: no turn/started and no turn/completed.
        review.send(error(notGitRepositoryError));

        const result = await review.prompt;
        expect(result).toMatchObject({stopReason: "end_turn"});
        expect(review.sessionState.currentTurnId).toBeNull();
        expect(review.sessionState.interruptTurnId).toBeNull();
        await expect(review.dump(result)).toMatchFileSnapshot("data/review-unspawned-error.json");

        const next = await runNextPrompt(review);
        expect(next.result).toMatchObject({stopReason: "end_turn"});
        await expect(next.dump).toMatchFileSnapshot("data/review-unspawned-error-next-prompt.json");
    });

    it("returns a typed failure when Codex fails before starting the review", async () => {
        const review = await startReview(typedFailureCapabilities, undefined, false, false);

        review.send(error(notGitRepositoryError));

        const result = await review.prompt;
        expect(result).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {id: `${parentTurnId}:error`, severity: "error"}}}},
        });
        await expect(review.dump(result)).toMatchFileSnapshot("data/review-unspawned-typed-failure.json");

        const next = await runNextPrompt(review);
        expect(next.result).toMatchObject({stopReason: "end_turn"});
        await expect(next.dump).toMatchFileSnapshot("data/review-unspawned-typed-failure-next-prompt.json");
    });

    it("still reports the next turn's own fatal error after an unspawned review", async () => {
        const review = await startReview(undefined, undefined, false, false);
        review.send(error(notGitRepositoryError));
        await review.prompt;

        const next = await runNextPrompt(review, notGitRepositoryError);
        expect(next.result).toMatchObject({stopReason: "end_turn"});
        await expect(next.dump).toMatchFileSnapshot("data/review-unspawned-error-next-prompt-fails.json");
    });

    it("keeps waiting for turn/completed after a fatal error once the review has started", async () => {
        const review = await startReview(undefined, undefined, false);
        let settled = false;
        void review.prompt.then(() => settled = true, () => settled = true);

        review.send(error(overloadedError));
        await review.fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(settled).toBe(false);

        review.send(turnCompleted("failed", overloadedError));
        await expect(review.prompt).resolves.toMatchObject({stopReason: "end_turn"});
    });
});

describe("normal turn ids", () => {
    it("uses the one turn id for both completion and interrupt", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const sessionState = await createSession(fixture);
        vi.spyOn(fixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({turn: turn("turn-id", "inProgress")});
        const turnInterrupt = vi.spyOn(fixture.getCodexAcpClient(), "turnInterrupt")
            .mockImplementation(async () => {
                fixture.sendServerNotification({method: "turn/completed", params: {threadId: sessionId, turn: turn("turn-id", "interrupted")}});
            });

        const prompt = agent.prompt({sessionId, prompt: [{type: "text", text: "hello"}]});
        await vi.waitFor(() => expect(sessionState.currentTurnId).toBe("turn-id"));
        fixture.sendServerNotification({method: "turn/started", params: {threadId: sessionId, turn: turn("turn-id", "inProgress")}});
        await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        expect(sessionState.interruptTurnId).toBe("turn-id");

        await agent.cancel({sessionId});

        expect(turnInterrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: "turn-id"});
        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
    });
});

async function startReview(
    clientCapabilities?: acp.ClientCapabilities,
    signal?: AbortSignal,
    childStarted = true,
    enteredReview = true,
): Promise<{
    fixture: CodexMockTestFixture,
    agent: CodexAcpServer,
    sessionState: SessionState,
    prompt: Promise<acp.PromptResponse>,
    send: (notification: ServerNotification) => void,
    dump: (response: acp.PromptResponse) => string,
}> {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    if (clientCapabilities) {
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities});
    }
    const sessionState = await createSession(fixture);
    const reviewStarted: ReviewStartResponse = {reviewThreadId: sessionId, turn: turn(parentTurnId, "inProgress")};
    vi.spyOn(fixture.getCodexAppServerClient(), "reviewStart").mockResolvedValue(reviewStarted);

    const prompt = agent.prompt({sessionId, prompt: [{type: "text", text: "/review"}]}, signal);
    await vi.waitFor(() => expect(sessionState.currentTurnId).toBe(parentTurnId));
    const send = (notification: ServerNotification) => fixture.sendServerNotification(notification);
    if (enteredReview) {
        send({
            method: "item/started",
            params: {
                threadId: sessionId,
                turnId: parentTurnId,
                startedAtMs: 0,
                item: {type: "enteredReviewMode", id: "entered-review", review: "current changes"},
            },
        });
    }
    if (enteredReview && childStarted) {
        send({method: "turn/started", params: {threadId: sessionId, turn: turn(childTurnId, "inProgress")}});
    }
    await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
    return {
        fixture,
        agent,
        sessionState,
        prompt,
        send,
        dump: (response) => JSON.stringify({
            // The command list is published asynchronously after session/new; it is not part of the turn.
            updates: fixture.getAcpConnectionEvents([])
                .map(event => event.args[0].update)
                .filter(update => update?.sessionUpdate !== "available_commands_update"),
            response,
        }, null, 2),
    };
}

// Codex reports the unfinished review's error again as the failure of the next turn.
async function runNextPrompt(
    review: Awaited<ReturnType<typeof startReview>>,
    ownError: ErrorNotification["error"] | null = null,
): Promise<{result: acp.PromptResponse, dump: string}> {
    const {fixture, agent, sessionState, send} = review;
    fixture.clearAcpConnectionDump();
    vi.spyOn(fixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({turn: turn("next-turn", "inProgress")});
    const prompt = agent.prompt({sessionId, prompt: [{type: "text", text: "hello"}]});
    await vi.waitFor(() => expect(sessionState.currentTurnId).toBe("next-turn"));
    send({method: "turn/started", params: {threadId: sessionId, turn: turn("next-turn", "inProgress")}});
    send({method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: "next-turn", itemId: "next-message", delta: "Hi."}});
    if (ownError) {
        send({method: "error", params: {threadId: sessionId, turnId: "next-turn", willRetry: false, error: ownError}});
    }
    send({method: "turn/completed", params: {threadId: sessionId, turn: turn("next-turn", "failed", ownError ?? notGitRepositoryError)}});
    const result = await prompt;
    return {result, dump: review.dump(result)};
}

async function createSession(fixture: CodexMockTestFixture): Promise<SessionState> {
    const codexAcpClient = fixture.getCodexAcpClient();
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
    await fixture.getCodexAcpAgent().newSession({cwd: "/test/cwd", mcpServers: []});
    fixture.clearAcpConnectionDump();
    return fixture.getCodexAcpAgent().getSessionState(sessionId);
}

function turn(
    id: string,
    status: "inProgress" | "completed" | "failed" | "interrupted",
    turnError: ErrorNotification["error"] | null = null,
) {
    return {
        id,
        items: [],
        itemsView: "notLoaded" as const,
        status,
        error: turnError,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function turnCompleted(
    status: "completed" | "failed" | "interrupted",
    turnError: ErrorNotification["error"] | null = null,
): ServerNotification {
    return {method: "turn/completed", params: {threadId: sessionId, turn: turn(parentTurnId, status, turnError)}};
}

function error(turnError: ErrorNotification["error"]): ServerNotification {
    return {method: "error", params: {threadId: sessionId, turnId: parentTurnId, willRetry: false, error: turnError}};
}

function agentMessageDelta(delta: string): ServerNotification {
    return {method: "item/agentMessage/delta", params: {threadId: sessionId, turnId: parentTurnId, itemId: "agent-message", delta}};
}
