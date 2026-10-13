import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import {SESSION_QUEUE_ACTIONS} from "../../SessionQueue";
import type {Turn} from "../../app-server/v2";

const sessionId = "session-id";
const turn: Turn = {id: "early", status: "inProgress", items: [], itemsView: "notLoaded", error: null,
    startedAt: null, completedAt: null, durationMs: null};
const request = {sessionId, cwd: "/test/cwd", mcpServers: []};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}
function setup() {
    const f = createCodexMockTestFixture();
    const agent = f.getCodexAcpAgent();
    const client = f.getCodexAcpClient();
    client.queueSupport = {nativeVersion: "0.160.1", actions: SESSION_QUEUE_ACTIONS};
    const boundary = agent as unknown as {
        installSessionState(state: SessionState): void;
        getOrCreateSessionWithHistory: (...args: unknown[]) => Promise<unknown>;
        streamThreadHistory: (...args: unknown[]) => Promise<void>;
        beginSessionOpen(id: string): number;
        cleanupStaleSessionOpen(id: string, generation: number): Promise<boolean>;
    };
    const state = createTestSessionState();
    const start = () => f.sendServerNotification({method: "turn/started", params: {threadId: sessionId, turn}});
    const complete = () => f.sendServerNotification({method: "turn/completed", params: {threadId: sessionId, turn: {...turn, status: "interrupted"}}});
    return {f, agent, client, boundary, state, start, complete};
}

describe("maintainer final server failure paths", () => {
    it("interrupts a raw native turn immediately while cold history replay is blocked", async () => {
        const h = setup();
        const replayEntered = deferred<void>();
        const release = deferred<void>();
        vi.spyOn(h.boundary, "getOrCreateSessionWithHistory").mockImplementationOnce(async () => {
            h.start();
            h.boundary.installSessionState(h.state);
            return {sessionId, modelState: {currentModelId: h.state.currentModelId, availableModels: []},
                modeState: h.state.agentMode.toSessionModeState(false), thread: {id: sessionId},
                history: (async function* () {})()};
        });
        vi.spyOn(h.boundary, "streamThreadHistory").mockImplementationOnce(async () => {
            replayEntered.resolve();
            await release.promise;
        });
        const interrupt = vi.spyOn(h.client, "turnInterrupt").mockResolvedValue();
        const load = h.agent.loadSession(request);
        await replayEntered.promise;
        try {
            await h.agent.cancel({sessionId});
            expect(interrupt).toHaveBeenCalledWith({threadId: sessionId, turnId: "early"});
        } finally {
            release.resolve();
            await load;
            await h.client.waitForSessionNotifications(sessionId);
            h.complete();
            await h.client.waitForSessionNotifications(sessionId);
        }
    });

    it("interrupts before metadata-failure helper releases the native subscription", async () => {
        const h = setup();
        const calls: string[] = [];
        vi.spyOn(h.client, "turnInterrupt").mockImplementation(async () => { calls.push("interrupt"); });
        const close = h.client.closeSession.bind(h.client);
        vi.spyOn(h.client, "closeSession").mockImplementation(async id => { calls.push("unsubscribe"); await close(id); });
        vi.spyOn(h.boundary, "getOrCreateSessionWithHistory").mockImplementationOnce(async () => {
            const generation = h.boundary.beginSessionOpen(sessionId);
            h.start();
            await h.boundary.cleanupStaleSessionOpen(sessionId, generation);
            throw new Error("metadata failed after subscription");
        });
        await expect(h.agent.loadSession(request)).rejects.toThrow("metadata failed after subscription");
        await h.client.waitForSessionNotifications(sessionId);
        expect(calls[0]).toBe("interrupt");
        expect(calls).toContain("unsubscribe");
    });
});
