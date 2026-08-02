import * as acp from "@agentclientprotocol/sdk";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {PLAN_COLLABORATION_MODE} from "../../CollaborationModeConfig";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    type CodexMockTestFixture,
} from "../acp-test-utils";

type TurnCompletion = {
    threadId: string;
    turn: {
        id: string;
        items: never[];
        itemsView: "notLoaded";
        status: "completed";
        error: null;
        startedAt: null;
        completedAt: null;
        durationMs: null;
    };
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {promise, resolve};
}

describe("CodexACPAgent - plan review", () => {
    let fixture: CodexMockTestFixture;
    const sessionId = "plan-review-session";

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    async function startPlanPrompt(permissionOptionId: string | null) {
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {plan: {}},
        });
        fixture.setPermissionResponse(permissionOptionId === null
            ? {outcome: {outcome: "cancelled"}}
            : {outcome: {outcome: "selected", optionId: permissionOptionId}});

        const sessionState = createTestSessionState({
            sessionId,
            collaborationMode: PLAN_COLLABORATION_MODE,
        });
        vi.spyOn(fixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);

        const planTurn = deferred<TurnCompletion>();
        const implementationTurn = deferred<TurnCompletion>();
        const turnStart = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart")
            .mockResolvedValueOnce({
                turn: {
                    id: "plan-turn",
                    items: [],
                    itemsView: "notLoaded",
                    status: "inProgress",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            })
            .mockResolvedValueOnce({
                turn: {
                    id: "implementation-turn",
                    items: [],
                    itemsView: "notLoaded",
                    status: "inProgress",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            });
        vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted")
            .mockImplementation((_threadId, turnId) => turnId === "plan-turn"
                ? planTurn.promise
                : implementationTurn.promise);

        const promptPromise = fixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{type: "text", text: "Plan the change"}],
        });
        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(1));

        fixture.sendServerNotification({
            method: "item/plan/delta",
            params: {
                threadId: sessionId,
                turnId: "plan-turn",
                itemId: "plan-item",
                delta: "# Implementation plan\n\n1. Make the change.",
            },
        });
        fixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: sessionId,
                turnId: "plan-turn",
                completedAtMs: 0,
                item: {
                    type: "plan",
                    id: "plan-item",
                    text: "# Implementation plan\n\n1. Make the change.",
                },
            },
        });
        planTurn.resolve({
            threadId: sessionId,
            turn: {
                id: "plan-turn",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });

        return {promptPromise, sessionState, turnStart, implementationTurn};
    }

    it("requests plan permission and starts one implementation turn when approved", async () => {
        const {promptPromise, sessionState, turnStart, implementationTurn} = await startPlanPrompt("implement_plan");

        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(2));
        expect(turnStart.mock.calls[1]![0]).toMatchObject({
            threadId: sessionId,
            input: [{type: "text", text: "Implement the approved plan."}],
        });

        const events = fixture.getAcpConnectionEvents([]);
        expect(events).toContainEqual({
            method: "requestPermission",
            args: [expect.objectContaining({
                sessionId,
                toolCall: expect.objectContaining({
                    toolCallId: "plan-review:plan-item",
                    title: "Implement this plan?",
                    kind: "switch_mode",
                    rawInput: {plan: "# Implementation plan\n\n1. Make the change."},
                }),
                options: [
                    {optionId: "implement_plan", name: "Yes, implement this plan", kind: "allow_once"},
                    {optionId: "revise_plan", name: "No, and tell Codex what to do differently", kind: "reject_once"},
                ],
            })],
        });
        expect(events).toContainEqual({
            method: "sessionUpdate",
            args: [{
                sessionId,
                update: {
                    sessionUpdate: "plan_update",
                    plan: {
                        type: "markdown",
                        planId: "plan-item",
                        content: "# Implementation plan\n\n1. Make the change.",
                    },
                },
            }],
        });
        const finalPlanUpdateIndex = events.reduce((lastIndex, event, index) =>
            event.method === "sessionUpdate"
            && (event.args[0] as {update?: {sessionUpdate?: string}}).update?.sessionUpdate === "plan_update"
                ? index
                : lastIndex,
        -1);
        const permissionIndex = events.findIndex(event => event.method === "requestPermission");
        expect(finalPlanUpdateIndex).toBeGreaterThanOrEqual(0);
        expect(permissionIndex).toBeGreaterThan(finalPlanUpdateIndex);
        expect(sessionState.collaborationMode).toBe("default");

        implementationTurn.resolve({
            threadId: sessionId,
            turn: {
                id: "implementation-turn",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(turnStart).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["revise_plan", "rejected"],
        [null, "cancelled"],
    ])("keeps plan mode and does not implement when review is %s", async (optionId, _description) => {
        const {promptPromise, sessionState, turnStart} = await startPlanPrompt(optionId);

        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(turnStart).toHaveBeenCalledTimes(1);
        expect(sessionState.collaborationMode).toBe(PLAN_COLLABORATION_MODE);
    });
});
