import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import {AgentMode} from "../../AgentMode";
import type {SessionState} from "../../CodexAcpServer";
import {CodexEventHandler} from "../../CodexEventHandler";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture,
} from "../acp-test-utils";

describe("CodexEventHandler - plan events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: "model-id[effort]",
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
    });

    it("emits the authoritative completed plan after buffering deltas", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-1",
                        text: "",
                    },
                },
            },
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-1",
                    delta: "### Implementation plan\n\n",
                },
            },
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-1",
                    delta: "1. Add the event mapping.\n2. Verify it.",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-1",
                        text: "Completed text should not duplicate the streamed plan.",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-deltas.json",
        );
    });

    it("falls back to buffered deltas when the completed plan is empty", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-2",
                    delta: "### Buffered plan\n\n",
                },
            },
            {
                method: "item/plan/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    itemId: "plan-2",
                    delta: "1. Use the buffered fallback.",
                },
            },
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-2",
                        text: "",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-delta-fallback.json",
        );
    });

    it("emits the completed plan when no deltas streamed", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {
                        type: "plan",
                        id: "plan-2",
                        text: "### Fallback plan\n\n1. Use the completed item.",
                    },
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-completed-fallback.json",
        );
    });

    it("keeps turn plan updates as ACP checklist updates", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "turn/plan/updated",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    explanation: "Implement and verify the mapping.",
                    plan: [
                        {
                            step: "Add the event mapping",
                            status: "completed",
                        },
                        {
                            step: "Verify it in Zed",
                            status: "inProgress",
                        },
                    ],
                },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        await expect(mockFixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/plan-checklist-update.json",
        );
    });

    describe("plan update coalescing", () => {
        function createHandler(
            notify = vi.fn(async (_method: unknown, _params: unknown) => {}),
        ) {
            const connection = {
                notify,
                request: vi.fn(),
            } as unknown as AcpClientConnection;
            const handler = new CodexEventHandler(connection, sessionState, true);
            const planUpdates = () => notify.mock.calls
                .map(call => call[1] as {update?: {sessionUpdate?: string, plan?: {planId: string, content: string}}})
                .filter(params => params.update?.sessionUpdate === "plan_update")
                .map(params => params.update!.plan!);
            return {handler, planUpdates};
        }

        function planDelta(itemId: string, delta: string): ServerNotification {
            return {
                method: "item/plan/delta",
                params: {threadId: sessionId, turnId: "turn-1", itemId, delta},
            };
        }

        function completedPlan(itemId: string, text: string): ServerNotification {
            return {
                method: "item/completed",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    completedAtMs: 0,
                    item: {type: "plan", id: itemId, text},
                },
            };
        }

        function completedTurn(status: "completed" | "interrupted"): ServerNotification {
            return {
                method: "turn/completed",
                params: {
                    threadId: sessionId,
                    turn: {
                        id: "turn-1",
                        items: [],
                        itemsView: "notLoaded",
                        status,
                        error: null,
                        startedAt: null,
                        completedAt: null,
                        durationMs: null,
                    },
                },
            };
        }

        it("coalesces many small deltas and emits the complete final snapshot", async () => {
            vi.useFakeTimers();
            const {handler, planUpdates} = createHandler();
            let fullText = "";

            for (let index = 0; index < 200; index += 1) {
                const delta = `${index % 10}`;
                fullText += delta;
                await handler.handleNotification(planDelta("plan-many", delta));
                if (index % 10 === 9) {
                    await vi.advanceTimersByTimeAsync(25);
                }
            }
            await handler.handleNotification(completedPlan("plan-many", fullText));

            expect(planUpdates().length).toBeLessThan(20);
            expect(planUpdates().length).toBeGreaterThan(1);
            expect(planUpdates().at(-1)).toEqual({type: "markdown", planId: "plan-many", content: fullText});
            await handler.dispose();
        });

        it.each(["completed", "interrupted"] as const)("flushes a pending snapshot when the turn is %s", async status => {
            vi.useFakeTimers();
            const {handler, planUpdates} = createHandler();
            await handler.handleNotification(planDelta("plan-boundary", "full pending plan"));

            await handler.handleNotification(completedTurn(status));

            expect(planUpdates()).toEqual([{type: "markdown", planId: "plan-boundary", content: "full pending plan"}]);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(planUpdates()).toHaveLength(1);
            await handler.dispose();
        });

        it("does not duplicate an identical completed snapshot", async () => {
            vi.useFakeTimers();
            const {handler, planUpdates} = createHandler();
            await handler.handleNotification(planDelta("plan-same", "same text"));
            await vi.advanceTimersByTimeAsync(150);

            await handler.handleNotification(completedPlan("plan-same", "same text"));

            expect(planUpdates()).toEqual([{type: "markdown", planId: "plan-same", content: "same text"}]);
            await handler.dispose();
        });

        it("serializes an in-flight throttled snapshot before the completed snapshot", async () => {
            vi.useFakeTimers();
            let releaseFirstSend!: () => void;
            let markFirstSendStarted!: () => void;
            const firstSendStarted = new Promise<void>(resolve => {
                markFirstSendStarted = resolve;
            });
            const firstSendReleased = new Promise<void>(resolve => {
                releaseFirstSend = resolve;
            });
            let firstSend = true;
            const notify = vi.fn(async (_method: unknown, _params: unknown) => {
                if (!firstSend) return;
                firstSend = false;
                markFirstSendStarted();
                await firstSendReleased;
            });
            const {handler, planUpdates} = createHandler(notify);
            await handler.handleNotification(planDelta("plan-race", "partial"));

            await vi.advanceTimersByTimeAsync(150);
            await firstSendStarted;
            const completion = handler.handleNotification(completedPlan("plan-race", "partial and final"));
            releaseFirstSend();
            await completion;

            expect(planUpdates().map(plan => plan.content)).toEqual(["partial", "partial and final"]);
            await handler.dispose();
        });

        it("flushes and cancels pending work when disposed", async () => {
            vi.useFakeTimers();
            const {handler, planUpdates} = createHandler();
            await handler.handleNotification(planDelta("plan-dispose", "last session snapshot"));

            await handler.dispose();
            await vi.advanceTimersByTimeAsync(1_000);

            expect(planUpdates()).toEqual([
                {type: "markdown", planId: "plan-dispose", content: "last session snapshot"},
            ]);
        });

        it("keeps independently streamed plans separate", async () => {
            vi.useFakeTimers();
            const {handler, planUpdates} = createHandler();
            await handler.handleNotification(planDelta("plan-a", "A1"));
            await handler.handleNotification(planDelta("plan-b", "B1"));
            await handler.handleNotification(planDelta("plan-a", "A2"));
            await handler.handleNotification(planDelta("plan-b", "B2"));

            await handler.handleNotification(completedTurn("completed"));

            expect(planUpdates()).toEqual([
                {type: "markdown", planId: "plan-a", content: "A1A2"},
                {type: "markdown", planId: "plan-b", content: "B1B2"},
            ]);
            await handler.dispose();
        });
    });
});
