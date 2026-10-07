import * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it, vi} from "vitest";
import {createRecoveryFixture, initialize, MODEL, type RecoveryFixture, requestsOf} from "./recovery-fixture";

const command = (status: "inProgress" | "completed") => ({
    type: "commandExecution", id: "cmd-1", pluginId: null, scriptPath: null, command: "sleep 30", cwd: "/work",
    processId: null, source: "agent", status, commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
});

async function openSession(fixture: RecoveryFixture, air = false): Promise<string> {
    await initialize(fixture, air);
    const {sessionId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
    return sessionId;
}

/** Starts a prompt and waits until its turn runs in the current app-server. */
async function startTurn(fixture: RecoveryFixture, sessionId: string, text = "hi") {
    fixture.answers.set("turn/start", () => ({turn: {id: "turn-1", items: [], status: "inProgress", error: null}}));
    const turnStarts = () => fixture.servers.reduce((count, server) => count + requestsOf(server, "turn/start").length, 0);
    const before = turnStarts();
    const prompt = fixture.agent.prompt({sessionId, prompt: [{type: "text", text}]});
    prompt.catch(() => undefined);
    await vi.waitFor(() => expect(turnStarts()).toBe(before + 1));
    await new Promise(resolve => setTimeout(resolve, 5));
    // Wrapped: an async function that returns a promise would wait for it.
    return {prompt};
}

function completeTurn(fixture: RecoveryFixture, sessionId: string, turnId = "turn-1") {
    fixture.current().rpc.notify({
        method: "turn/completed",
        params: {threadId: sessionId, turn: {id: turnId, items: [], status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null}},
    });
}

describe("app-server recovery", () => {
    it("starts the app-server again on the next request after an idle crash, with the same handshake", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);

        await fixture.kill();
        const list = await fixture.agent.listSessions({});

        expect(list.sessions).toEqual([]);
        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "initialize")).toEqual([expect.objectContaining({
            clientInfo: expect.objectContaining({name: "test-client", version: "1.0"}),
        })]);
    });

    it("starts one app-server for concurrent requests", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        await fixture.kill();

        await Promise.all([
            fixture.agent.listSessions({}),
            fixture.agent.listSessions({}),
            fixture.agent.newSession({cwd: "/work", mcpServers: []}),
        ]);

        expect(fixture.servers).toHaveLength(2);
    });

    it("fails a request in flight with the signal of the exit, not with a disposed connection", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        fixture.answers.set("thread/list", () => undefined);
        const list = fixture.agent.listSessions({});
        list.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.current().rpc.hasPending("thread/list")).toBe(true));

        await fixture.kill();

        await expect(list).rejects.toMatchObject({
            code: 1001,
            message: expect.stringContaining("was killed by SIGKILL, which usually means it ran out of memory. The agent starts it again on the next request."),
        });
    });

    it("answers end_turn with a transport_lost failure to an AIR client", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture, true);
        const {prompt} = await startTurn(fixture, sessionId);

        await fixture.kill();

        const response = await prompt;
        expect(response.stopReason).toBe("end_turn");
        expect(JSON.stringify(response._meta)).toContain("Connection to Codex was lost.");
    });

    it("counts a crash during the restart handshake and tries again on the next request", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        await fixture.kill();
        let handshakes = 0;
        fixture.answers.set("initialize", (_params, server) => {
            handshakes++;
            if (handshakes === 1) {
                setImmediate(() => server.child.die(null, "SIGKILL"));
                return undefined;
            }
            return {userAgent: "codex-test", codexHome: "/codex-home"};
        });

        await expect(fixture.agent.listSessions({})).rejects.toMatchObject({code: 1001, message: expect.stringContaining("SIGKILL")});
        await expect(fixture.agent.listSessions({})).resolves.toMatchObject({sessions: []});
        expect(fixture.servers).toHaveLength(3);
    });

    it("stops restarting after the crash limit and says what to do", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "2"}});
        await openSession(fixture);
        await fixture.kill();
        await fixture.agent.listSessions({});
        // The second crash restarts after the backoff of 1 s.
        await fixture.kill();

        await expect(fixture.agent.listSessions({})).rejects.toMatchObject({
            code: 1001,
            message: expect.stringMatching(/crashed 2 times in the last 5 min \(last: it was killed by SIGKILL.*\), so the agent stopped restarting it\. Restart the agent/),
        });
        expect(fixture.servers).toHaveLength(2);
    });

    it("refuses a session that crashed the app-server twice while opening, and keeps others working", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "10"}});
        await openSession(fixture);
        fixture.answers.set("thread/resume", (params, server) => {
            if ((params as {threadId: string}).threadId !== "huge") return undefined === params ? {} : {
                thread: {id: (params as {threadId: string}).threadId, turns: [], historyMode: "paginated", status: {type: "idle"}},
                model: "gpt-test", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, itemsBackwardsCursor: null,
            };
            setImmediate(() => server.child.die(null, "SIGKILL"));
            return undefined;
        });
        const resumeHuge = () => fixture.agent.resumeSession({sessionId: "huge", cwd: "/work", mcpServers: []});

        await expect(resumeHuge()).rejects.toMatchObject({message: expect.stringContaining("SIGKILL")});
        await expect(resumeHuge()).rejects.toMatchObject({message: expect.stringContaining("SIGKILL")});
        await expect(resumeHuge()).rejects.toMatchObject({
            message: expect.stringContaining("2 times while opening session huge, so the agent does not open this session again"),
        });
        await expect(fixture.agent.resumeSession({sessionId: "small", cwd: "/work", mcpServers: []})).resolves.toBeDefined();
        expect(fixture.servers).toHaveLength(3);
    });

    it("closes a session of a dead app-server without starting one", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();

        await fixture.agent.closeSession({sessionId});
        await fixture.agent.cancel({sessionId});

        expect(fixture.servers).toHaveLength(1);
    });

    it("explains that a session without messages was lost", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        fixture.answers.set("thread/resume", () => new Error("no rollout found for thread id thread-new"));
        fixture.answers.set("thread/read", () => new Error("thread not loaded"));

        await expect(fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "hi"}]})).rejects.toMatchObject({
            code: 1001,
            message: `Session ${sessionId} had no messages yet and was lost when the Codex app-server restarted. Start a new session.`,
        });
    });

    it("keeps a collaboration mode chosen while the app-server was down", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();

        await fixture.agent.setSessionConfigOption({sessionId, configId: "collaboration_mode", value: "plan"});
        expect(fixture.servers).toHaveLength(1);
        const {prompt} = await startTurn(fixture, sessionId);
        completeTurn(fixture, sessionId);
        await prompt;

        expect(requestsOf(fixture.current(), "thread/settings/update")).toEqual([expect.objectContaining({
            threadId: sessionId,
            collaborationMode: expect.objectContaining({mode: "plan"}),
        })]);
    });

    it("does not start an app-server during shutdown", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        await fixture.kill();
        fixture.supervisor.shutdown();

        await expect(fixture.agent.listSessions({})).rejects.toMatchObject({message: expect.stringContaining("shutting down")});
        expect(fixture.servers).toHaveLength(1);
    });

    it("stops an app-server whose handshake finished after shutdown began", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        await fixture.kill();
        fixture.answers.set("initialize", () => undefined);

        const list = fixture.agent.listSessions({});
        await vi.waitFor(() => expect(fixture.servers).toHaveLength(2));
        const restarted = fixture.current();
        restarted.child.stdin.on("finish", () => restarted.child.die(0));
        fixture.supervisor.shutdown();

        await expect(list).rejects.toMatchObject({code: 1001});
        await vi.waitFor(() => expect(restarted.rpc.disposed).toBe(true));
    });

    it("resumes a session once for concurrent uses after a crash", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        const agent = fixture.agent as unknown as {ensureSessionReady(state: unknown): Promise<void> | undefined};
        const state = fixture.agent.getSessionState(sessionId);

        await Promise.all([agent.ensureSessionReady(state), agent.ensureSessionReady(state), fixture.agent.listSessions({})]);
        const {prompt} = await startTurn(fixture, sessionId);
        completeTurn(fixture, sessionId);
        await prompt;

        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
    });

    it("drops a lazy resume that finishes after the session closed", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        fixture.answers.set("thread/resume", () => undefined);

        const prompt = fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "hi"}]});
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        await fixture.agent.closeSession({sessionId});
        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        fixture.current().rpc.resolve("thread/resume", {
            thread: {id: sessionId, turns: [], historyMode: "paginated", status: {type: "idle"}},
            model: "gpt-test", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, itemsBackwardsCursor: null,
        });

        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([{threadId: sessionId}]));
        expect(fixture.agent.getSessionState.bind(fixture.agent, sessionId)).toThrow("not found");
    });

    it("restarts a dead app-server for a provider update and resumes the sessions once", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();

        await fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});

        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "initialize")).toHaveLength(1);
        expect(requestsOf(fixture.current(), "thread/resume")).toEqual([expect.objectContaining({threadId: sessionId})]);
        const {prompt} = await startTurn(fixture, sessionId);
        completeTurn(fixture, sessionId);
        await prompt;
        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
    });

    it("keeps the provider routing of the agent across a crash restart", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        await fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        await fixture.kill();

        await fixture.agent.newSession({cwd: "/work", mcpServers: []});

        expect(fixture.agent.listProviders({}).providers[0]!.current).toEqual({apiType: "openai", baseUrl: "https://gateway.example/v1"});
        expect(requestsOf(fixture.current(), "thread/start")).toEqual([expect.objectContaining({modelProvider: "custom-gateway"})]);
    });
});
