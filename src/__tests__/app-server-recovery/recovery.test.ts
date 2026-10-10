import * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it, vi} from "vitest";
import {ConnectionError, ConnectionErrors, ResponseError} from "vscode-jsonrpc/node";
import {createRecoveryFixture, defaultAnswer, initialize, MODEL, type RecoveryFixture, requestsOf} from "./recovery-fixture";
import {AppServerRecovery} from "../../app-server-recovery/AppServerRecovery";
import type {CodexAcpClient} from "../../CodexAcpClient";

const resumed = (id: string) => ({
    thread: {id, turns: [], historyMode: "paginated", status: {type: "idle"}, preview: "", ephemeral: false, modelProvider: "openai",
        createdAt: 0, updatedAt: 0, path: null, cwd: "/work", cliVersion: "0", source: "appServer", agentNickname: null,
        agentRole: null, gitInfo: null, name: null},
    model: "gpt-test", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, itemsBackwardsCursor: null, cwd: "/work",
});

type Internals = {ensureSessionReady(state: unknown): Promise<void> | undefined, recovery: AppServerRecovery<never>};
const internals = (fixture: RecoveryFixture) => fixture.agent as unknown as Internals;

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

    it("feeds the thread notifications of a restarted app-server to the session index", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        const observe = vi.spyOn(fixture.agent.sessionIndex, "observe");

        await fixture.kill();
        await fixture.agent.listSessions({});

        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe.mock.calls[0]![0].appServerClient).not.toBe(undefined);
    });

    it("keeps a session list subscription across a crash and reads each change of the new app-server once", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture, true, {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure", "sessionIndex"]}}}});
        fixture.answers.set("thread/read", (params) => ({thread: {
            ...resumed((params as {threadId: string}).threadId).thread,
            preview: "hi", source: "vscode", path: "/codex-home/sessions/t.jsonl", recencyAt: null, name: `title ${fixture.servers.length}`,
        }}));
        const {subscriptionId} = await fixture.agent.sessionIndex.subscribeList({cwd: "/work"});
        const changes = () => fixture.acp.notify.mock.calls.filter(call => (call as unknown[])[0] === "_session/list/changes")
            .map(call => (call as unknown[])[1]);

        await fixture.kill();
        await fixture.agent.listSessions({});
        expect(fixture.servers).toHaveLength(2);
        // Observing the running client again adds no second listener.
        const running = (fixture.agent as unknown as {codexAcpClient: CodexAcpClient}).codexAcpClient;
        const listeners = () => (running.appServerClient as unknown as {codexEventHandlers: unknown[]}).codexEventHandlers.length;
        const before = listeners();
        fixture.agent.sessionIndex.observe(running);
        expect(listeners()).toBe(before);
        fixture.current().rpc.notify({method: "thread/name/updated", params: {threadId: "thread-a"}});

        await vi.waitFor(() => expect(changes()).toEqual([{
            subscriptionId,
            sessions: [expect.objectContaining({sessionId: "thread-a", title: "title 2"})],
            removed: [],
        }]));
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(changes()).toHaveLength(1);
        expect(requestsOf(fixture.current(), "thread/read")).toHaveLength(1);
        expect(fixture.agent.sessionIndex.subscriptionResources()).toMatchObject({subscriptions: 1, groups: 1});
        fixture.agent.sessionIndex.dispose();
    });

    it("forgets the failed turns and reviews of a crashed app-server in the session index", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture, true, {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure", "sessionIndex"]}}}});
        const row = {...resumed("thread-a").thread, preview: "hi", source: "vscode", recencyAt: null, status: {type: "idle"}};
        fixture.answers.set("thread/list", (params) => ({data: (params as {archived?: boolean}).archived ? [] : [row], nextCursor: null}));
        fixture.current().rpc.notify({method: "turn/completed", params: {threadId: "thread-a", turn: {
            id: "t", items: [], status: "failed", error: {message: "boom", codexErrorInfo: null, additionalDetails: null},
            startedAt: null, completedAt: null, durationMs: null,
        }}});
        await vi.waitFor(async () => expect(((await fixture.agent.listSessions({cwd: "/work"})).sessions[0]!._meta as any).jetbrains.air.state).toBe("error"));

        await fixture.kill();
        const sessions = (await fixture.agent.listSessions({cwd: "/work"})).sessions;
        expect((sessions[0]!._meta as any).jetbrains.air.state).toBe("idle");
    });

    it("tells a subscription of the state of a listed row that the restart of the app-server changed", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture, true, {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure", "sessionIndex"]}}}});
        const row = (status: {type: string}) => ({...resumed("thread-a").thread, preview: "hi", source: "vscode", recencyAt: null,
            path: "/codex-home/sessions/t.jsonl", status});
        let loaded = true;
        fixture.answers.set("thread/list", (params) => ({
            data: (params as {archived?: boolean, cwd?: unknown}).archived || (params as {cwd?: unknown}).cwd === undefined
                ? [] : [row({type: loaded ? "idle" : "notLoaded"})],
            nextCursor: null,
        }));
        fixture.answers.set("thread/read", () => ({thread: row({type: loaded ? "idle" : "notLoaded"})}));
        const {subscriptionId} = await fixture.agent.sessionIndex.subscribeList({cwd: "/work"});
        expect(((await fixture.agent.listSessions({cwd: "/work"})).sessions[0]!._meta as any).jetbrains.air.state).toBe("idle");

        await fixture.kill();
        loaded = false;
        await fixture.agent.listSessions({cwd: "/work"});

        await vi.waitFor(() => expect(fixture.acp.notify.mock.calls
            .filter(call => (call as unknown[])[0] === "_session/list/changes")
            .map(call => (call as unknown[])[1])).toEqual([{
            subscriptionId,
            sessions: [expect.objectContaining({sessionId: "thread-a"})],
            removed: [],
        }]));
        fixture.agent.sessionIndex.dispose();
    });

    it("starts the app-server again for a rename or an archive of the session index", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture, true, {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure", "sessionIndex"]}}}});
        fixture.answers.set("thread/read", (params) => ({thread: {...resumed((params as {threadId: string}).threadId).thread, path: "/codex-home/sessions/t.jsonl"}}));

        await fixture.kill();
        await fixture.agent.sessionIndex.rename({sessionId: "thread-a", title: "New title"});
        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "thread/name/set")).toEqual([expect.objectContaining({threadId: "thread-a"})]);

        await fixture.kill();
        await fixture.agent.sessionIndex.setArchived({sessionId: "thread-a"}, true);
        expect(fixture.servers).toHaveLength(3);
        expect(requestsOf(fixture.current(), "thread/archive")).toHaveLength(1);
    });

    it("starts the app-server again to list or trust the startup hooks", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        fixture.answers.set("hooks/list", () => ({data: [{cwd: "/work", hooks: [], warnings: [], errors: []}]}));

        await fixture.kill();
        await fixture.agent.listHooks("/work");
        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "hooks/list")).toHaveLength(1);

        await fixture.kill();
        await fixture.agent.trustHooks("/work", []);
        expect(fixture.servers).toHaveLength(3);
        expect(requestsOf(fixture.current(), "hooks/list")).toHaveLength(2);
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

    it("ends a streaming prompt promptly, fails its open tool call and resumes the session on the next prompt", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.agent.setSessionConfigOption({sessionId, configId: "model", value: MODEL.id});
        await fixture.agent.setSessionConfigOption({sessionId, configId: "reasoning_effort", value: "high"});
        const {prompt} = await startTurn(fixture, sessionId);
        fixture.current().rpc.notify({
            method: "item/started",
            params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: command("inProgress")},
        });
        await vi.waitFor(() => expect(fixture.updates().some(u => u.update["sessionUpdate"] === "tool_call")).toBe(true));

        await fixture.kill();

        await expect(prompt).rejects.toMatchObject({code: 1001, message: expect.stringContaining("SIGKILL")});
        expect(fixture.updates()).toContainEqual(expect.objectContaining({
            sessionId,
            update: expect.objectContaining({sessionUpdate: "tool_call_update", toolCallId: "cmd-1", status: "failed"}),
        }));

        const {prompt: next} = await startTurn(fixture, sessionId, "again");
        completeTurn(fixture, sessionId);
        await expect(next).resolves.toMatchObject({stopReason: "end_turn"});
        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "thread/resume")).toEqual([expect.objectContaining({threadId: sessionId, cwd: "/work"})]);
        expect(requestsOf(fixture.current(), "turn/start").filter(params => (params as {threadId: string}).threadId === sessionId))
            .toEqual([expect.objectContaining({threadId: sessionId, model: MODEL.id, effort: "high"})]);
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

    it("answers cancelled when the client cancelled before the app-server died", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        fixture.answers.set("turn/interrupt", () => undefined);
        const {prompt} = await startTurn(fixture, sessionId);

        void fixture.agent.cancel({sessionId});
        await vi.waitFor(() => expect(fixture.current().rpc.hasPending("turn/interrupt")).toBe(true));
        await fixture.kill();

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it("cancels a permission request of the dead turn and settles it without the client's answer", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        let permissionSignal: AbortSignal | undefined;
        fixture.acp.request.mockImplementation(async (method: string, _params: unknown, options?: {cancellationSignal?: AbortSignal}) => {
            if (method === acp.methods.client.session.requestPermission) {
                permissionSignal = options?.cancellationSignal;
                return await new Promise(() => {});
            }
            return {};
        });
        const {prompt} = await startTurn(fixture, sessionId);
        const server = fixture.current();
        const approval = server.rpc.requestHandlers.get("item/commandExecution/requestApproval")!({
            threadId: sessionId, turnId: "turn-1", itemId: "cmd-1", command: "rm -rf build", cwd: "/work", reason: null,
            availableDecisions: ["accept", "decline", "cancel"],
        });
        await vi.waitFor(() => expect(permissionSignal).toBeDefined());

        await fixture.kill();

        await expect(prompt).rejects.toMatchObject({code: 1001});
        expect(permissionSignal!.aborted).toBe(true);
        await expect(approval).resolves.toEqual({decision: "cancel"});
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

    it("stops restarting after the crash limit and says what to do, with the stderr of the last crash", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "2"}});
        await openSession(fixture);
        await fixture.kill();
        await fixture.agent.listSessions({});
        fixture.current().child.stderr.write("memory allocation of 4096 bytes failed\n");
        await vi.waitFor(() => expect(fixture.supervisor.current.connection.process.stderr.readableLength).toBe(0));
        // The second crash restarts after the backoff of 1 s.
        await fixture.kill();

        await expect(fixture.agent.listSessions({})).rejects.toMatchObject({
            code: 1001,
            message: expect.stringMatching(
                /crashed 2 times in the last 5 min \(last: it was killed by SIGKILL.*\), so the agent stopped restarting it\. Restart the agent.*\nmemory allocation of 4096 bytes failed$/,
            ),
        });
        expect(fixture.servers).toHaveLength(2);
    });

    it("does not promise a restart when the app-server exits before its initialize handshake", async () => {
        const fixture = createRecoveryFixture();
        fixture.answers.set("initialize", () => undefined);
        const initializing = initialize(fixture);
        initializing.catch(() => undefined);
        const server = fixture.current();
        await vi.waitFor(() => expect(requestsOf(server, "initialize")).toHaveLength(1));
        server.child.stderr.write("Error: invalid hooks config\n");
        await vi.waitFor(() => expect(server.child.stderr.readableLength).toBe(0));

        server.child.die(1);

        const error = await initializing.then(() => null, (failure: unknown) => failure as acp.RequestError);
        expect(error).toMatchObject({code: 1001, message: "Codex process has exited with code 1:\nError: invalid hooks config"});
        expect(error?.message).not.toContain("starts it again");
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

    it("stops the restarted app-server when shutdown begins during its handshake", async () => {
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

    it("completes a provider update when a session without messages cannot be resumed, and reports the loss on that session", async () => {
        const fixture = createRecoveryFixture();
        const empty = await openSession(fixture);
        await fixture.agent.resumeSession({sessionId: "persisted", cwd: "/work", mcpServers: []});
        fixture.answers.set("thread/resume", (params) => (params as {threadId: string}).threadId === empty
            ? new Error(`no rollout found for thread id ${empty}`)
            : defaultAnswer("thread/resume", params));
        fixture.answers.set("thread/read", () => new Error("thread not loaded"));

        await fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});

        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "thread/resume")).toEqual(expect.arrayContaining([
            expect.objectContaining({threadId: empty}),
            expect.objectContaining({threadId: "persisted"}),
        ]));
        await expect(fixture.agent.prompt({sessionId: empty, prompt: [{type: "text", text: "hi"}]})).rejects.toMatchObject({
            code: 1001,
            message: `Session ${empty} had no messages yet and was lost when the Codex app-server restarted. Start a new session.`,
        });
        const {prompt} = await startTurn(fixture, "persisted");
        completeTurn(fixture, "persisted");
        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
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

    it("joins the resume in flight when a second use comes after the restart", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        fixture.answers.set("thread/resume", () => undefined);
        const state = fixture.agent.getSessionState(sessionId);

        const first = internals(fixture).ensureSessionReady(state)!;
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        const second = internals(fixture).ensureSessionReady(state)!;
        fixture.current().rpc.resolve("thread/resume", resumed(sessionId));
        await Promise.all([first, second]);

        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
    });

    it("does not resume lazily while the client opens the session, and never unsubscribes that open", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        fixture.answers.set("thread/resume", () => undefined);

        const explicit = fixture.agent.resumeSession({sessionId, cwd: "/work", mcpServers: []});
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        const lazy = internals(fixture).ensureSessionReady(fixture.agent.getSessionState(sessionId))!;
        await expect(lazy).rejects.toMatchObject({message: expect.stringContaining("opened again")});
        fixture.current().rpc.resolve("thread/resume", resumed(sessionId));
        await explicit;

        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
        expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([]);
        expect(internals(fixture).ensureSessionReady(fixture.agent.getSessionState(sessionId))).toBeUndefined();
    });

    it("applies a collaboration mode that changed while the resume applied the previous one", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        await fixture.agent.setSessionConfigOption({sessionId, configId: "collaboration_mode", value: "plan"});
        fixture.answers.set("thread/settings/update", () => undefined);

        const ready = internals(fixture).ensureSessionReady(fixture.agent.getSessionState(sessionId))!;
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/settings/update")).toBe(true));
        await fixture.agent.setSessionConfigOption({sessionId, configId: "collaboration_mode", value: "default"});
        fixture.answers.set("thread/settings/update", () => ({}));
        fixture.current().rpc.resolve("thread/settings/update", {});
        await ready;

        const modes = (requestsOf(fixture.current(), "thread/settings/update") as Array<{collaborationMode: {mode: string}}>)
            .map(update => update.collaborationMode.mode);
        expect(modes).toEqual(["plan", "default"]);
    });

    it("unsubscribes a thread whose session closed while the resume applied the collaboration mode", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        await fixture.agent.setSessionConfigOption({sessionId, configId: "collaboration_mode", value: "plan"});
        fixture.answers.set("thread/settings/update", () => undefined);

        const ready = internals(fixture).ensureSessionReady(fixture.agent.getSessionState(sessionId))!;
        ready.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/settings/update")).toBe(true));
        await fixture.agent.closeSession({sessionId});
        fixture.current().rpc.resolve("thread/settings/update", {});

        await expect(ready).rejects.toMatchObject({code: 1001});
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([{threadId: sessionId}]));
    });

    it("lets goal control wait for a provider restart instead of resuming the session again", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        const goal = {threadId: sessionId, objective: "ship it", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2};
        fixture.answers.set("thread/goal/set", (_params, server) => {
            setImmediate(() => server.rpc.notify({method: "thread/goal/updated", params: {threadId: sessionId, turnId: null, goal}}));
            return {goal};
        });
        fixture.answers.set("thread/resume", () => undefined);

        const update = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        const pause = fixture.agent.extMethod("_session/goal", {sessionId, action: "pause"});
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(requestsOf(fixture.current(), "thread/goal/set")).toEqual([]);
        fixture.current().rpc.resolve("thread/resume", resumed(sessionId));
        await update;
        await pause;

        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
        expect(requestsOf(fixture.current(), "thread/goal/set")).toEqual([expect.objectContaining({threadId: sessionId, status: "paused"})]);
    });

    it("applies a collaboration mode chosen during the resume of a provider restart", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        fixture.answers.set("thread/resume", () => undefined);

        const update = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        await fixture.agent.setSessionConfigOption({sessionId, configId: "collaboration_mode", value: "plan"});
        fixture.current().rpc.resolve("thread/resume", resumed(sessionId));
        await update;

        expect(requestsOf(fixture.current(), "thread/settings/update")).toEqual([expect.objectContaining({
            threadId: sessionId,
            collaborationMode: expect.objectContaining({mode: "plan"}),
        })]);
    });

    it("unsubscribes a thread whose session closed during the resume of a provider restart", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        fixture.answers.set("thread/resume", () => undefined);

        const update = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        update.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        await fixture.agent.closeSession({sessionId});
        const waiting = fixture.agent.newSession({cwd: "/work", mcpServers: []});
        fixture.current().rpc.resolve("thread/resume", resumed(sessionId));

        await expect(update).resolves.toEqual({});
        await expect(waiting).resolves.toMatchObject({sessionId: "thread-new"});

        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([{threadId: sessionId}]));
    });

    it("unsubscribes a thread whose lazy resume failed after the thread was subscribed and the session closed", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        await fixture.kill();
        fixture.answers.set("model/list", () => undefined);

        const ready = internals(fixture).ensureSessionReady(fixture.agent.getSessionState(sessionId))!;
        ready.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("model/list")).toBe(true));
        await fixture.agent.closeSession({sessionId});
        const pending = fixture.current().rpc.pending.find(request => request.method === "model/list")!;
        pending.reject(new Error("model list failed"));

        await expect(ready).rejects.toBeDefined();
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/unsubscribe")).toEqual([{threadId: sessionId}]));
    });

    it("checks the crash limit again after the draining app-server counted its crash, before a provider restart", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "1"}});
        await openSession(fixture);
        fixture.current().child.emit("exit", null, "SIGKILL");

        await expect(fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"}))
            .rejects.toMatchObject({code: 1001, message: expect.stringContaining("stopped restarting it")});
        expect(fixture.servers).toHaveLength(1);
    });

    it("counts provider restarts whose handshake fails, so they cannot start app-servers without a limit", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "2"}});
        await openSession(fixture);
        fixture.answers.set("initialize", () => new Error("initialize failed"));
        const setProvider = () => fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});

        await expect(setProvider()).rejects.toThrow("initialize failed");
        await expect(setProvider()).rejects.toThrow("initialize failed");
        await expect(setProvider()).rejects.toMatchObject({message: expect.stringContaining("stopped restarting it")});
        expect(fixture.servers).toHaveLength(3);
    });

    it("reads the history of two sessions one request at a time after a crash that hit both", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "10"}});
        await initialize(fixture);
        fixture.answers.set("thread/resume", () => undefined);
        const a = fixture.agent.resumeSession({sessionId: "a", cwd: "/work", mcpServers: []});
        const b = fixture.agent.resumeSession({sessionId: "b", cwd: "/work", mcpServers: []});
        a.catch(() => undefined);
        b.catch(() => undefined);
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(2));
        await fixture.kill();
        await expect(a).rejects.toMatchObject({code: 1001});
        await expect(b).rejects.toMatchObject({code: 1001});

        const again = [
            fixture.agent.resumeSession({sessionId: "a", cwd: "/work", mcpServers: []}),
            fixture.agent.resumeSession({sessionId: "b", cwd: "/work", mcpServers: []}),
        ];
        await vi.waitFor(() => expect(fixture.servers.length === 2 && requestsOf(fixture.current(), "thread/resume").length).toBe(1));
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
        fixture.current().rpc.resolve("thread/resume", resumed("a"));
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(2));
        fixture.current().rpc.resolve("thread/resume", resumed("b"));
        await Promise.all(again);
    });

    it("fails a provider restart whose new app-server never answers initialize, and recovers after it", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        (internals(fixture).recovery as unknown as {limits: {handshakeTimeoutMs: number}}).limits.handshakeTimeoutMs = 30;
        fixture.answers.set("initialize", (_params, server) => server === fixture.servers[1] ? undefined : {userAgent: "x", codexHome: "/h"});

        await expect(fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"}))
            .rejects.toMatchObject({code: 1001});
        await expect(fixture.agent.listSessions({})).resolves.toMatchObject({sessions: []});
        expect(fixture.servers).toHaveLength(3);
    });

    it("keeps an error that the app-server answered before it died", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        fixture.answers.set("thread/list", (_params, server) => {
            setImmediate(() => server.child.die(null, "SIGKILL"));
            return new Error("Invalid cursor");
        });

        await expect(fixture.agent.listSessions({})).rejects.toThrow("Invalid cursor");
    });

    it("starts no new request on an app-server whose exit was seen while its output drains", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        const server = fixture.current();
        server.child.emit("exit", null, "SIGKILL");

        expect(internals(fixture).recovery.isReady()).toBe(false);
        expect(internals(fixture).recovery.ensureRunning()).toBeInstanceOf(Promise);
        await fixture.agent.listSessions({});
        expect(fixture.servers).toHaveLength(2);
        expect((internals(fixture).recovery as unknown as {crashGuard: {count(): number}}).crashGuard.count()).toBe(1);
    });

    it("counts an app-server that cannot be started and reports it as 1001", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        await fixture.kill();
        const supervisor = fixture.supervisor as unknown as {spawnConnection: () => never};
        supervisor.spawnConnection = () => {
            throw new Error("Cannot find module '@openai/codex/bin/codex.js'");
        };

        await expect(fixture.agent.listSessions({})).rejects.toMatchObject({
            code: 1001,
            message: expect.stringContaining("could not be started: Cannot find module"),
        });
        expect((internals(fixture).recovery as unknown as {crashGuard: {count(): number}}).crashGuard.count()).toBe(2);
    });

    it("fails the open tool calls of a prompt whose request was aborted when the app-server died", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        fixture.answers.set("turn/start", () => ({turn: {id: "turn-1", items: [], status: "inProgress", error: null}}));
        fixture.answers.set("turn/interrupt", () => undefined);
        const abort = new AbortController();
        const prompt = fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "hi"}]}, abort.signal);
        await vi.waitFor(() => expect(requestsOf(fixture.current(), "turn/start")).toHaveLength(1));
        fixture.current().rpc.notify({
            method: "item/started",
            params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: command("inProgress")},
        });
        await vi.waitFor(() => expect(fixture.updates().some(u => u.update["sessionUpdate"] === "tool_call")).toBe(true));
        abort.abort();

        await fixture.kill();

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
        expect(fixture.updates()).toContainEqual(expect.objectContaining({
            update: expect.objectContaining({sessionUpdate: "tool_call_update", toolCallId: "cmd-1", status: "failed"}),
        }));
    });

    it("lets a prompt that waited for a provider update whose app-server died restart the app-server", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        fixture.answers.set("initialize", (_params, server) => {
            if (server !== fixture.servers[1]) return {userAgent: "codex-test", codexHome: "/codex-home"};
            setImmediate(() => server.child.die(null, "SIGKILL"));
            return undefined;
        });

        const update = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        update.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.servers).toHaveLength(2));
        fixture.answers.set("turn/start", () => ({turn: {id: "turn-1", items: [], status: "inProgress", error: null}}));
        const prompt = fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "hi"}]});
        await expect(update).rejects.toMatchObject({code: 1001, message: expect.stringContaining("SIGKILL")});
        await vi.waitFor(() => expect(fixture.servers.length === 3 && requestsOf(fixture.current(), "turn/start").length).toBe(1));
        completeTurn(fixture, sessionId);

        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
        expect(requestsOf(fixture.current(), "thread/resume")).toEqual([expect.objectContaining({threadId: sessionId})]);
    });

    it("does not name the exit of another app-server for a connection that died before its exit was seen", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        await fixture.kill();
        await fixture.agent.listSessions({});
        const recovery = internals(fixture).recovery as unknown as {mapError(error: unknown, client: unknown): {message: string}};
        const client = (fixture.agent as unknown as {codexAcpClient: unknown}).codexAcpClient;

        const mapped = recovery.mapError(new ConnectionError(ConnectionErrors.Closed, "Connection is closed."), client);

        expect(mapped.message).toBe("The connection to the Codex app-server was lost. The agent starts it again on the next request.");
    });

    it("lets requests that waited for a provider update go on when its app-server died during the resumes", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        fixture.answers.set("thread/resume", (_params, server) => server === fixture.servers[1] ? undefined : resumed(sessionId));

        const update = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        update.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("thread/resume")).toBe(true));
        fixture.answers.set("turn/start", () => ({turn: {id: "turn-1", items: [], status: "inProgress", error: null}}));
        const prompt = fixture.agent.prompt({sessionId, prompt: [{type: "text", text: "hi"}]});
        await fixture.kill();

        await expect(update).rejects.toMatchObject({code: 1001, message: expect.stringContaining("SIGKILL")});
        await vi.waitFor(() => expect(fixture.servers.length === 3 && requestsOf(fixture.current(), "turn/start").length).toBe(1));
        completeTurn(fixture, sessionId);
        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("keeps an error answer of a live app-server whose text mentions a closed connection", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        fixture.answers.set("thread/list", () => new ResponseError(-32603, "failed to start MCP server docs: Connection is closed"));

        await expect(fixture.agent.listSessions({})).rejects.toThrow("failed to start MCP server docs: Connection is closed");
        await expect(fixture.agent.listSessions({})).rejects.not.toMatchObject({code: 1001});
    });

    it("fails a tool call whose start was still queued when the app-server died", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        let releaseFirstToolCall: () => void = () => {};
        const firstToolCallSent = new Promise<void>(resolve => {
            releaseFirstToolCall = resolve;
        });
        let blocked = false;
        fixture.acp.notify.mockImplementation(async (_method: string, params: {update?: {sessionUpdate?: string, toolCallId?: string}}) => {
            if (!blocked && params?.update?.sessionUpdate === "tool_call" && params.update.toolCallId === "cmd-1") {
                blocked = true;
                await firstToolCallSent;
            }
        });
        const {prompt} = await startTurn(fixture, sessionId);
        const second = {...command("inProgress"), id: "cmd-2"};
        fixture.current().rpc.notify({method: "item/started", params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: command("inProgress")}});
        fixture.current().rpc.notify({method: "item/started", params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: second}});
        await vi.waitFor(() => expect(blocked).toBe(true));

        await fixture.kill();
        setTimeout(releaseFirstToolCall, 20);

        await expect(prompt).rejects.toMatchObject({code: 1001});
        const statuses = fixture.updates()
            .filter(u => u.update["toolCallId"] === "cmd-2" && u.update["status"] !== undefined)
            .map(u => u.update["status"]);
        expect(statuses.at(-1)).toBe("failed");
    });

    it("does not install a provider app-server whose initialize answered after the handshake timeout", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        (internals(fixture).recovery as unknown as {limits: {handshakeTimeoutMs: number}}).limits.handshakeTimeoutMs = 100;
        // The new app-server ignores the end of its stdin long enough to answer initialize after the timeout.
        (fixture.supervisor as unknown as {timings: {terminateAfterMs: number}}).timings.terminateAfterMs = 2_000;
        const previous = fixture.current();
        previous.child.stdin.on("finish", () => previous.child.die(0));
        fixture.answers.set("initialize", (_params, server) => server === fixture.servers[1] ? undefined : {userAgent: "x", codexHome: "/h"});
        const update = fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"});
        update.catch(() => undefined);
        await vi.waitFor(() => expect(fixture.servers.length === 2 && fixture.current().rpc.hasPending("initialize")).toBe(true), {interval: 5});
        const replacement = fixture.current();
        await new Promise(resolve => setTimeout(resolve, 150));
        replacement.rpc.resolve("initialize", {userAgent: "late", codexHome: "/h"});

        await expect(update).rejects.toMatchObject({code: 1001, message: expect.stringContaining("did not answer initialize")});
        expect(internals(fixture).recovery.isReady()).toBe(false);
    });

    it("ends a turn with end_turn when its turn/completed was delivered right before the app-server died", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        const {prompt} = await startTurn(fixture, sessionId);
        const server = fixture.current();
        completeTurn(fixture, sessionId);
        server.child.die(null, "SIGKILL");

        await expect(prompt).resolves.toMatchObject({stopReason: "end_turn"});
    });

    it("counts restarts whose handshake timed out also when the next request comes before the child exited", async () => {
        const fixture = createRecoveryFixture();
        await openSession(fixture);
        const recovery = internals(fixture).recovery as unknown as {limits: {handshakeTimeoutMs: number, backoffMs: number[]}};
        recovery.limits.handshakeTimeoutMs = 20;
        recovery.limits.backoffMs = [0];
        // Every restarted app-server hangs in initialize and ignores the end of its stdin until SIGTERM.
        fixture.answers.set("initialize", (_params, server) => server === fixture.servers[0] ? {userAgent: "x", codexHome: "/h"} : undefined);
        (fixture.supervisor as unknown as {timings: {terminateAfterMs: number}}).timings.terminateAfterMs = 200;
        await fixture.kill();

        for (let attempt = 0; attempt < 6; attempt++) {
            await fixture.agent.listSessions({}).catch(() => undefined);
        }

        // The kill and four timed-out restarts reach the limit of 5; no further app-server is started.
        expect(fixture.servers.length).toBeLessThanOrEqual(5);
        await expect(fixture.agent.listSessions({})).rejects.toMatchObject({message: expect.stringContaining("stopped restarting it")});
    });

    it("answers cancelled when session/cancel comes while the crash cleanup publishes", async () => {
        const fixture = createRecoveryFixture();
        const sessionId = await openSession(fixture);
        const {prompt} = await startTurn(fixture, sessionId);
        fixture.current().rpc.notify({method: "item/started", params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: command("inProgress")}});
        await vi.waitFor(() => expect(fixture.updates().some(u => u.update["sessionUpdate"] === "tool_call")).toBe(true));
        let releaseFailedUpdate: () => void = () => {};
        const held = new Promise<void>(resolve => {
            releaseFailedUpdate = resolve;
        });
        let failedUpdateSeen = false;
        fixture.acp.notify.mockImplementation(async (_method: string, params: {update?: {status?: string}}) => {
            if (params?.update?.status === "failed" && !failedUpdateSeen) {
                failedUpdateSeen = true;
                await held;
            }
        });

        await fixture.kill();
        await vi.waitFor(() => expect(failedUpdateSeen).toBe(true));
        await fixture.agent.cancel({sessionId});
        releaseFailedUpdate();

        await expect(prompt).resolves.toMatchObject({stopReason: "cancelled"});
    });

    it("completes an accepted URL elicitation that the dead app-server can no longer resolve", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture, false, {elicitation: {url: {}}});
        const {sessionId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        fixture.acp.request.mockImplementation(async (method: string) => method === acp.methods.client.elicitation.create
            ? {action: "accept"}
            : {outcome: {outcome: "cancelled"}});
        const {prompt} = await startTurn(fixture, sessionId);
        const response = await fixture.current().rpc.requestHandlers.get("mcpServer/elicitation/request")!({
            threadId: sessionId, turnId: "turn-1", serverName: "auth-server", mode: "url", _meta: null,
            message: "Please authorize access", url: "https://example.com/authorize", elicitationId: "elicit-123",
        });
        expect(response).toMatchObject({action: "accept"});

        await fixture.kill();

        await expect(prompt).rejects.toMatchObject({code: 1001});
        expect(fixture.acp.notify).toHaveBeenCalledWith(acp.methods.client.elicitation.complete, {elicitationId: "elicit-123"});
    });

    it("reports a crash during the history read of session/load as the exit of the app-server", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        fixture.answers.set("thread/resume", (params) => ({...resumed((params as {threadId: string}).threadId), itemsBackwardsCursor: "cursor-1"}));
        fixture.answers.set("thread/items/list", (_params, server) => {
            setImmediate(() => server.child.die(null, "SIGKILL"));
            return undefined;
        });

        await expect(fixture.agent.loadSession({sessionId: "big", cwd: "/work", mcpServers: []})).rejects.toMatchObject({
            code: 1001,
            message: expect.stringContaining("SIGKILL"),
        });
    });

    it("fails the background tasks of every session at the crash, before any of them publishes", async () => {
        const fixture = createRecoveryFixture();
        await initialize(fixture);
        const first = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        fixture.answers.set("thread/start", () => ({...resumed("thread-second"), model: "gpt-test"}));
        const second = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
        const firstTasks = fixture.agent.getSessionState(first.sessionId).asyncTasks;
        const secondTasks = fixture.agent.getSessionState(second.sessionId).asyncTasks;
        vi.spyOn(firstTasks, "finishAll").mockReturnValue(new Promise(() => {}));
        const secondFinish = vi.spyOn(secondTasks, "finishAll").mockResolvedValue();

        await fixture.kill();

        expect(secondFinish).toHaveBeenCalledWith("failed");
    });

    it("does not fail a provider update for a session that the agent refuses to open", async () => {
        const fixture = createRecoveryFixture({env: {CODEX_ACP_APP_SERVER_CRASH_LIMIT: "10"}});
        await initialize(fixture);
        fixture.answers.set("thread/resume", (params, server) => {
            const threadId = (params as {threadId: string}).threadId;
            if (threadId === "huge") {
                setImmediate(() => server.child.die(null, "SIGKILL"));
                return undefined;
            }
            return resumed(threadId);
        });
        await fixture.agent.resumeSession({sessionId: "small", cwd: "/work", mcpServers: []});
        const sessions = (fixture.agent as unknown as {sessions: Map<string, unknown>}).sessions;
        const small = sessions.get("small")!;
        sessions.set("huge", {...(small as object), sessionId: "huge"});
        for (let attempt = 0; attempt < 2; attempt++) {
            await fixture.agent.resumeSession({sessionId: "huge", cwd: "/work", mcpServers: []}).catch(() => undefined);
        }

        await expect(fixture.agent.setProvider({providerId: "openai", apiType: "openai", baseUrl: "https://gateway.example/v1"}))
            .resolves.toEqual({});
    });
});
