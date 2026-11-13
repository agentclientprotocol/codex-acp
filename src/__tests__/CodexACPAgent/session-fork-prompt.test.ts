import {describe, expect, it, vi} from "vitest";
import {
    createRecoveryFixture,
    defaultAnswer,
    initialize,
    type RecoveryFixture,
    requestsOf,
} from "../app-server-recovery/recovery-fixture";

/**
 * An app-server that sends the notifications of a thread only to a connection subscribed to it, as Codex does:
 * `thread/start`, `thread/resume` and `thread/fork` subscribe the thread they answer, `thread/unsubscribe` ends
 * the subscription. Codex keeps an unsubscribed thread loaded and accepts `turn/start` for it, but sends none of
 * its turn notifications, so a prompt of an unsubscribed session waits forever.
 */
function subscribingAppServer(fixture: RecoveryFixture): Set<string> {
    const subscribed = new Set<string>();
    const subscribe = (method: string) => fixture.answers.set(method, params => {
        const answer = method === "thread/fork"
            ? {...defaultAnswer("thread/resume", {threadId: "fork-id"}) as object}
            : defaultAnswer(method, params);
        subscribed.add((answer as {thread: {id: string}}).thread.id);
        return answer;
    });
    subscribe("thread/start");
    subscribe("thread/resume");
    subscribe("thread/fork");
    fixture.answers.set("thread/unsubscribe", params => {
        const {threadId} = params as {threadId: string};
        return {status: subscribed.delete(threadId) ? "unsubscribed" : "notSubscribed"};
    });
    let turns = 0;
    fixture.answers.set("turn/start", params => {
        const {threadId} = params as {threadId: string};
        const turn = {id: `turn-${++turns}`, items: [], status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null};
        setTimeout(() => {
            if (!subscribed.has(threadId)) return;
            const rpc = fixture.current().rpc;
            rpc.notify({method: "turn/started", params: {threadId, turn}});
            rpc.notify({method: "turn/completed", params: {threadId, turn: {...turn, status: "completed"}}});
        }, 1);
        return {turn};
    });
    return subscribed;
}

const CLIENTS = [
    {name: "a client that is not AIR", air: false, capabilities: {}},
    {name: "AIR without the session index", air: true, capabilities: {}},
    {
        name: "AIR with the session index",
        air: true,
        capabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure", "sessionIndex"]}}}},
    },
];

async function promptWithin(fixture: RecoveryFixture, sessionId: string, ms = 1000) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the prompt of ${sessionId} did not end within ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "hi"}]}), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

describe("a prompt after session/fork", () => {
    for (const client of CLIENTS) {
        it(`ends for ${client.name}, and the source session still gets its turns`, async () => {
            const fixture = createRecoveryFixture();
            const subscribed = subscribingAppServer(fixture);
            await initialize(fixture, client.air, client.capabilities);
            const {sessionId: sourceId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});

            const {sessionId: forkId} = await fixture.agent.forkSession({sessionId: sourceId, cwd: "/work", mcpServers: []});

            expect(forkId).toBe("fork-id");
            await expect(promptWithin(fixture, forkId)).resolves.toMatchObject({stopReason: "end_turn"});
            await expect(promptWithin(fixture, sourceId)).resolves.toMatchObject({stopReason: "end_turn"});
            expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([]);
            expect(subscribed).toContain(forkId);
            expect(subscribed).toContain(sourceId);
            fixture.agent.sessionIndex.dispose();
        });
    }

    it("gives the subscription of the fork back when the fork fails after thread/fork", async () => {
        const fixture = createRecoveryFixture();
        const subscribed = subscribingAppServer(fixture);
        await initialize(fixture, true);
        const {sessionId: sourceId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        fixture.answers.set("model/list", () => new Error("model list failed"));

        await expect(fixture.agent.forkSession({sessionId: sourceId, cwd: "/work", mcpServers: []})).rejects.toThrow();

        expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([{threadId: "fork-id"}]);
        expect(subscribed).not.toContain("fork-id");
        expect(subscribed).toContain(sourceId);
    });

    it("gives the subscription of the fork back when the auth status of the fork fails", async () => {
        const fixture = createRecoveryFixture();
        const subscribed = subscribingAppServer(fixture);
        await initialize(fixture, true);
        const {sessionId: sourceId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        const agent = fixture.agent as unknown as {getAuthStateForProvider(): Promise<unknown>};
        vi.spyOn(agent, "getAuthStateForProvider").mockRejectedValueOnce(new Error("auth status failed"));

        await expect(fixture.agent.forkSession({sessionId: sourceId, cwd: "/work", mcpServers: []}))
            .rejects.toThrow("auth status failed");

        expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([{threadId: "fork-id"}]);
        expect(subscribed).not.toContain("fork-id");
        expect(subscribed).toContain(sourceId);
    });

    it("keeps the subscription of a fork that the client loaded while the fork failed", async () => {
        const fixture = createRecoveryFixture();
        const subscribed = subscribingAppServer(fixture);
        await initialize(fixture, true);
        const {sessionId: sourceId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        const agent = fixture.agent as unknown as {getAuthStateForProvider(): Promise<unknown>};
        let failAuth: (error: Error) => void = () => {};
        const auth = vi.spyOn(agent, "getAuthStateForProvider")
            .mockImplementationOnce(() => new Promise((_, reject) => { failAuth = reject; }));
        const fork = fixture.agent.forkSession({sessionId: sourceId, cwd: "/work", mcpServers: []});
        fork.catch(() => undefined);
        await vi.waitFor(() => expect(auth).toHaveBeenCalled());

        // The client found the new thread in the session list.
        await fixture.agent.loadSession({sessionId: "fork-id", cwd: "/work", mcpServers: []});
        failAuth(new Error("auth status failed"));

        await expect(fork).rejects.toThrow("auth status failed");
        expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([]);
        expect(subscribed).toContain("fork-id");
        await expect(promptWithin(fixture, "fork-id")).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("keeps a load of the fork out while a failed fork gives its subscription back", async () => {
        const fixture = createRecoveryFixture();
        subscribingAppServer(fixture);
        await initialize(fixture, true);
        const {sessionId: sourceId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        const agent = fixture.agent as unknown as {getAuthStateForProvider(): Promise<unknown>};
        vi.spyOn(agent, "getAuthStateForProvider").mockRejectedValueOnce(new Error("auth status failed"));
        fixture.answers.set("thread/unsubscribe", () => undefined);

        const fork = fixture.agent.forkSession({sessionId: sourceId, cwd: "/work", mcpServers: []});
        fork.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.current().rpc.hasPending("thread/unsubscribe")).toBe(true));

        await expect(fixture.agent.loadSession({sessionId: "fork-id", cwd: "/work", mcpServers: []}))
            .rejects.toMatchObject({data: "Session fork-id is closing"});
        fixture.current().rpc.resolve("thread/unsubscribe", {status: "unsubscribed"});
        await expect(fork).rejects.toThrow("auth status failed");
    });

    it("ends after the client loads the fork", async () => {
        const fixture = createRecoveryFixture();
        subscribingAppServer(fixture);
        await initialize(fixture, true);
        const {sessionId: sourceId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        const {sessionId: forkId} = await fixture.agent.forkSession({sessionId: sourceId, cwd: "/work", mcpServers: []});

        await fixture.agent.loadSession({sessionId: forkId, cwd: "/work", mcpServers: []});

        await expect(promptWithin(fixture, forkId)).resolves.toMatchObject({stopReason: "end_turn"});
    });
});
