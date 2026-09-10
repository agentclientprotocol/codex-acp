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
        status: "completed" | "failed";
        error: null | {
            message: string;
            codexErrorInfo: "serverOverloaded";
            additionalDetails: string | null;
            misalignment: null;
        };
        startedAt: null;
        completedAt: null;
        durationMs: null;
    };
};

type TurnStartResponse = {
    turn: {
        id: string;
        items: never[];
        itemsView: "notLoaded";
        status: "inProgress";
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

    async function startPlanPrompt(
        permissionOptionId: string | null,
        options: {
            typedFailures?: boolean;
            emitCompletionNotification?: boolean;
            implementationStart?: Promise<TurnStartResponse>;
            permissionResponse?: acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;
            initialModelId?: string;
        } = {},
    ) {
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                plan: {},
                ...(options.typedFailures
                    ? {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}}}
                    : {}),
            },
        });
        fixture.setPermissionResponse(options.permissionResponse ?? (permissionOptionId === null
            ? {outcome: {outcome: "cancelled"}}
            : {outcome: {outcome: "selected", optionId: permissionOptionId}}));

        const sessionState = createTestSessionState({
            sessionId,
            collaborationMode: PLAN_COLLABORATION_MODE,
            ...(options.initialModelId === undefined ? {} : {currentModelId: options.initialModelId}),
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
            .mockImplementationOnce(() => options.implementationStart ?? Promise.resolve({
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
            }));
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
        const completion: TurnCompletion = {
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
        };
        if (options.emitCompletionNotification) {
            fixture.sendServerNotification({method: "turn/completed", params: completion});
        }
        planTurn.resolve(completion);

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

    it("receipts the captured model when settings change during plan approval", async () => {
        const permission = deferred<acp.RequestPermissionResponse>();
        const {promptPromise, sessionState, turnStart, implementationTurn} = await startPlanPrompt(
            "implement_plan",
            {
                initialModelId: "gpt-5.6-sol[xhigh]",
                permissionResponse: permission.promise,
            },
        );

        sessionState.currentModelId = "gpt-5.6-terra[medium]";
        permission.resolve({outcome: {outcome: "selected", optionId: "implement_plan"}});
        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(2));
        expect(turnStart.mock.calls[1]![0]).toMatchObject({
            model: "gpt-5.6-sol",
            effort: "xhigh",
        });

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
        const response = await promptPromise;

        expect(response._meta?.["codex"]).toMatchObject({
            turnConfiguration: {
                turns: [
                    {turnId: "plan-turn", requested: {model: "gpt-5.6-sol", effort: "xhigh"}},
                    {turnId: "implementation-turn", requested: {model: "gpt-5.6-sol", effort: "xhigh"}},
                ],
            },
        });
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

    it("routes a terminal error during plan approval as a session-scoped failure", async () => {
        const permission = deferred<acp.RequestPermissionResponse>();
        const {promptPromise, sessionState, turnStart} = await startPlanPrompt(null, {
            typedFailures: true,
            emitCompletionNotification: true,
            permissionResponse: permission.promise,
        });
        await vi.waitFor(() => {
            expect(fixture.getAcpConnectionEvents([])).toContainEqual({
                method: "requestPermission",
                args: [expect.objectContaining({sessionId})],
            });
        });
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "plan-turn",
                willRetry: false,
                error: {
                    message: "Codex is temporarily overloaded.",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: "secret approval detail",
                    misalignment: null,
                },
            },
        });
        await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates).toEqual([{
            sessionUpdate: "session_info_update",
            _meta: {
                jetbrains: {
                    air: {
                        version: 1,
                        sessionFailure: {
                            id: "plan-turn:error",
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
        expect(JSON.stringify(updates)).not.toContain("secret approval detail");
        expect(turnStart).toHaveBeenCalledTimes(1);

        permission.resolve({outcome: {outcome: "cancelled"}});
        await expect(promptPromise).resolves.toMatchObject({stopReason: "end_turn"});
        expect(sessionState.sessionFailure).toMatchObject({severity: "error", revision: 1});
    });

    it("keeps the plan-approval failure in history after successful implementation", async () => {
        const permission = deferred<acp.RequestPermissionResponse>();
        const {promptPromise, sessionState, turnStart, implementationTurn} = await startPlanPrompt(null, {
            typedFailures: true,
            emitCompletionNotification: true,
            permissionResponse: permission.promise,
        });
        await vi.waitFor(() => expect(fixture.getAcpConnectionEvents([])
            .some(event => event.method === "requestPermission")).toBe(true));
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "plan-turn",
                willRetry: false,
                error: {
                    message: "late plan failure",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: null,
                    misalignment: null,
                },
            },
        });
        await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        const activeId = sessionState.sessionFailure!.id;

        permission.resolve({outcome: {outcome: "selected", optionId: "implement_plan"}});
        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(2));
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

        const failures = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update?._meta?.jetbrains?.air?.sessionFailure)
            .filter(Boolean);
        expect(failures).toEqual([
            expect.objectContaining({id: activeId, severity: "error", revision: 1}),
        ]);
        expect(sessionState.sessionFailure).toBeUndefined();
    });

    it("keeps an implementation failure terminal on the prompt response", async () => {
        const {promptPromise, sessionState, turnStart, implementationTurn} = await startPlanPrompt("implement_plan", {
            typedFailures: true,
            emitCompletionNotification: true,
        });
        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(2));
        fixture.clearAcpConnectionDump();
        const implementationError = {
            message: "Codex is temporarily overloaded.",
            codexErrorInfo: "serverOverloaded" as const,
            additionalDetails: "secret implementation detail",
            misalignment: null,
        };
        fixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "implementation-turn",
                willRetry: false,
                error: implementationError,
            },
        });
        const failedCompletion: TurnCompletion = {
            threadId: sessionId,
            turn: {
                id: "implementation-turn",
                items: [],
                itemsView: "notLoaded",
                status: "failed",
                error: implementationError,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        };
        fixture.sendServerNotification({method: "turn/completed", params: failedCompletion});
        implementationTurn.resolve(failedCompletion);

        const response = await promptPromise;
        expect(response).toMatchObject({
            stopReason: "end_turn",
            _meta: {jetbrains: {air: {sessionFailure: {
                id: "implementation-turn:error",
                category: "service",
                severity: "error",
            }}}},
        });
        expect(JSON.stringify(response)).not.toContain("secret implementation detail");
        expect(sessionState.sessionFailure).toMatchObject({severity: "error", revision: 1});
    });

    it("keeps the approval-to-implementation-start gap session-scoped", async () => {
        const permission = deferred<acp.RequestPermissionResponse>();
        const implementationStart = deferred<TurnStartResponse>();
        const {promptPromise, sessionState, turnStart, implementationTurn} = await startPlanPrompt(null, {
            typedFailures: true,
            emitCompletionNotification: true,
            permissionResponse: permission.promise,
            implementationStart: implementationStart.promise,
        });
        await vi.waitFor(() => expect(fixture.getAcpConnectionEvents([])
            .some(event => event.method === "requestPermission")).toBe(true));
        permission.resolve({outcome: {outcome: "selected", optionId: "implement_plan"}});
        await vi.waitFor(() => expect(turnStart).toHaveBeenCalledTimes(2));
        expect(sessionState.currentTurnId).toBeNull();
        fixture.clearAcpConnectionDump();

        fixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "implementation-turn",
                willRetry: false,
                error: {
                    message: "failure before implementation start",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: null,
                    misalignment: null,
                },
            },
        });
        await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        expect(sessionState.sessionFailure).toMatchObject({severity: "error", revision: 1});

        implementationStart.resolve({
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
        expect(sessionState.sessionFailure).toBeUndefined();
    });
});
