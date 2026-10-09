import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture} from "../acp-test-utils";
import {CodexSubagentSubscriptions, type Subscription} from "../../subagents/CodexSubagentSubscriptions";
import type {ApprovalHandler, ElicitationHandler, CodexAppServerClient} from "../../CodexAppServerClient";
import type {ServerNotification} from "../../app-server";
import type {Turn} from "../../app-server/v2";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}
const turn = (id: string, status: Turn["status"] = "inProgress"): Turn => ({
    id, status, items: [], itemsView: "notLoaded", error: null,
    startedAt: null, completedAt: null, durationMs: null,
});
function owner(): Subscription {
    return {
        rootSessionId: "root", supportsSubagents: true,
        dispatch: vi.fn(), enqueueInteraction: vi.fn(),
        approvalHandler: {
            handleCommandExecution: vi.fn().mockResolvedValue({decision: "accept"}),
            handleFileChange: vi.fn().mockResolvedValue({decision: "accept"}),
            handlePermissionsRequest: vi.fn().mockResolvedValue({permissions: {network: {enabled: true}}, scope: "turn", strictAutoReview: false}),
        },
        elicitationHandler: {
            handleElicitation: vi.fn().mockResolvedValue({action: "accept", content: null, _meta: null}),
            handleUserInput: vi.fn().mockResolvedValue({answers: {answer: {answers: ["yes"]}}}),
        },
        waitForRootNotifications: vi.fn().mockResolvedValue(undefined),
        waitForChildSession: vi.fn().mockImplementation(async id => id),
    };
}
function setup() {
    const events = new Map<string, (event: ServerNotification) => void>();
    const approvals = new Map<string, ApprovalHandler>();
    const elicitations = new Map<string, ElicitationHandler>();
    const subscriptions = new CodexSubagentSubscriptions({
        onServerNotification: (id: string, callback: (event: ServerNotification) => void) => events.set(id, callback),
        onApprovalRequest: (id: string, handler: ApprovalHandler) => approvals.set(id, handler),
        onElicitationRequest: (id: string, handler: ElicitationHandler) => elicitations.set(id, handler),
        clearThreadHandlers: (id: string) => { events.delete(id); approvals.delete(id); elicitations.delete(id); },
    } as unknown as CodexAppServerClient);
    const subscription = owner();
    subscription.captureChild = () => subscription;
    subscriptions.subscribe(subscription);
    const emit = (threadId: string, method: string, params: object) =>
        events.get(threadId)?.({method, params: {threadId, ...params}} as ServerNotification);
    const spawn = (tool = "spawnAgent") => emit("root", "item/completed", {
        turnId: "parent", item: {type: "collabAgentToolCall", tool, receiverThreadIds: ["child"]},
    });
    const reuse = () => {
        emit("child", "turn/completed", {turn: turn("old", "completed")});
        spawn("sendInput");
        emit("child", "turn/started", {turn: turn("new")});
    };
    spawn();
    emit("child", "turn/started", {turn: turn("old")});
    return {events, approvals, elicitations, subscriptions, subscription, emit, reuse};
}
const interactions = [
    ["handleCommandExecution", {decision: "cancel"}],
    ["handleFileChange", {decision: "cancel"}],
    ["handlePermissionsRequest", {permissions: {}, scope: "turn", strictAutoReview: false}],
    ["handleElicitation", {action: "cancel", content: null, _meta: null}],
    ["handleUserInput", {answers: {}}],
] as const;
function request(h: ReturnType<typeof setup>, method: typeof interactions[number][0], turnId: string | null) {
    const handlers = {...h.approvals.get("child")!, ...h.elicitations.get("child")!};
    // This unit boundary only consumes thread/turn IDs; downstream handlers are mocks.
    return (handlers[method] as (params: {threadId: string; turnId: string | null}) => Promise<unknown>)({threadId: "child", turnId});
}

describe("queue subscription generation boundaries", () => {
    it.each(interactions)("rejects stale child turn IDs for %s and preserves the new turn", async (method, rejected) => {
        const h = setup();
        h.reuse();
        expect(await request(h, method, "old")).toEqual(rejected);
        expect(await request(h, method, "new")).not.toEqual(rejected);
    });

    it.each(interactions)("rejects %s captured before a child generation replacement", async (method, rejected) => {
        const h = setup();
        const gate = deferred<void>();
        vi.mocked(h.subscription.waitForRootNotifications).mockReturnValueOnce(gate.promise);
        const pending = request(h, method, "old");
        h.reuse();
        gate.resolve();
        expect(await pending).toEqual(rejected);
    });

    it("rechecks generation after waiting for child materialization", async () => {
        const h = setup();
        const entered = deferred<void>();
        const gate = deferred<string | null>();
        vi.mocked(h.subscription.waitForChildSession).mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const pending = request(h, "handleCommandExecution", "old");
        await entered.promise;
        h.reuse();
        gate.resolve("child");
        expect(await pending).toEqual({decision: "cancel"});
    });

    it("does not let old starts or completions reopen or end a reused child", async () => {
        const h = setup();
        const oldCallback = h.events.get("child")!;
        h.reuse();
        h.emit("child", "turn/started", {turn: turn("old")});
        h.emit("child", "turn/completed", {turn: turn("old", "completed")});
        oldCallback({method: "turn/completed", params: {threadId: "child", turn: turn("old", "completed")}});
        expect(await request(h, "handleCommandExecution", "new")).toEqual({decision: "accept"});
        h.emit("child", "turn/completed", {turn: turn("new", "completed")});
        h.emit("child", "turn/started", {turn: turn("new")});
        expect(await request(h, "handleCommandExecution", "new")).toEqual({decision: "cancel"});
    });

    it("rejects uncorrelated elicitation when its child turn changes during the barrier", async () => {
        const h = setup();
        const gate = deferred<void>();
        vi.mocked(h.subscription.waitForRootNotifications).mockReturnValueOnce(gate.promise);
        const pending = request(h, "handleElicitation", null);
        h.reuse();
        gate.resolve();
        expect(await pending).toMatchObject({action: "cancel"});
    });

    it("observes root lifecycle synchronously during a prompt and fences retired callbacks", async () => {
        const f = createCodexMockTestFixture();
        const client = f.getCodexAcpClient();
        const native = f.getCodexAppServerClient();
        const registrations = vi.spyOn(native, "onServerNotification");
        const old = owner();
        const gate = deferred<void>();
        const observed = vi.fn();
        vi.mocked(old.dispatch).mockImplementation(() => gate.promise);
        const attach = (subscription: Subscription, watch: typeof observed) => client.subscribeToQueueEvents(
            "root", subscription.dispatch, subscription.approvalHandler, subscription.elicitationHandler,
            true, subscription.enqueueInteraction, subscription.waitForChildSession, true, undefined, watch,
        );
        await attach(old, observed);
        await client.subscribeToSessionEvents("root", old.dispatch, old.approvalHandler, old.elicitationHandler,
            true, old.enqueueInteraction, old.waitForChildSession);
        const callback = registrations.mock.calls[0]![1];
        const started: ServerNotification = {method: "turn/started", params: {threadId: "root", turn: turn("first")}};
        callback(started);
        expect(observed).toHaveBeenCalledExactlyOnceWith(started);
        const fresh = owner();
        const freshObserved = vi.fn();
        await attach(fresh, freshObserved);
        callback(started);
        expect(observed).toHaveBeenCalledTimes(1);
        expect(freshObserved).not.toHaveBeenCalled();
        gate.resolve();
        await client.waitForSessionNotifications("root");
        expect(fresh.dispatch).not.toHaveBeenCalled();
    });
});
