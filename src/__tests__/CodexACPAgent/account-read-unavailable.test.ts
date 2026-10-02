import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {
    createCodexMockTestFixture,
    createTestModel,
    type CodexMockTestFixture,
    type MethodCallEvent,
} from "../acp-test-utils";
import {AUTH_STATUS_UPDATE_METHOD, type AuthStatus} from "../../AuthStatusMeta";
import {ModelId} from "../../ModelId";
import type {GetAccountResponse} from "../../app-server/v2";

const SESSION_ID = "session-1";
const SIGNED_IN: GetAccountResponse = {
    account: {type: "chatgpt", email: "user@example.com", planType: "plus"},
    requiresOpenaiAuth: true,
} as GetAccountResponse;

/** The grace time of `session/load`, see `ACCOUNT_READ_LOAD_GRACE_MS`. */
const ACCOUNT_READ_LOAD_GRACE_MS = 1_000;
const SIGNED_IN_STATUS: AuthStatus = {kind: "account", label: "ChatGPT Plus", account: {email: "user@example.com", plan: "plus"}};
const NONE_STATUS: AuthStatus = {kind: "none", label: "Not logged in"};

/** The error of `account/read` when the backend refused the token, also after a refresh. */
function unauthorized(): ResponseError<unknown> {
    return new ResponseError(-32603, "workspace routing discovery unauthorized (401)");
}

/** An `account/read` answer that the test gives later. */
function pendingRead() {
    let resolve: (response: GetAccountResponse) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    return {
        start: () => new Promise<GetAccountResponse>((onResolve, onReject) => {
            resolve = onResolve;
            reject = onReject;
        }),
        resolve: (response: GetAccountResponse) => resolve(response),
        reject: (error: unknown) => reject(error),
    };
}

/** Loads the session while the grace timer is fake, and checks that the load waits the whole grace time. */
async function loadAfterGrace(fixture: CodexMockTestFixture): Promise<void> {
    let answered = false;
    const load = fixture.getCodexAcpAgent()
        .loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []})
        .then(() => {
            answered = true;
        });
    await vi.advanceTimersByTimeAsync(ACCOUNT_READ_LOAD_GRACE_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await load;
}

/** The error of `account/read` when the ChatGPT backend is not reachable. */
function routingFailure(): ResponseError<unknown> {
    return new ResponseError(-32603, "workspace routing discovery failed");
}

function authStatusUpdates(fixture: CodexMockTestFixture): AuthStatus[] {
    return fixture.getAcpConnectionEvents([])
        .filter((event: MethodCallEvent) => event.method === "notify" && event.args[0] === AUTH_STATUS_UPDATE_METHOD)
        .map((event: MethodCallEvent) => (event.args[1] as {authStatus: AuthStatus}).authStatus);
}

function historyTexts(fixture: CodexMockTestFixture): string[] {
    return fixture.getAcpConnectionEvents([])
        .filter((event: MethodCallEvent) => event.method === "sessionUpdate")
        .map((event: MethodCallEvent) => event.args[0].update)
        .filter(update => update.sessionUpdate === "agent_message_chunk")
        .map(update => update.content.text);
}

async function drainScheduledWork(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

/** A fixture whose `thread/resume` answers a session with one history message. */
function fixtureWithSession(): CodexMockTestFixture {
    const fixture = createCodexMockTestFixture();
    const client = fixture.getCodexAcpClient();
    const appServer = fixture.getCodexAppServerClient();
    client.listSkills = vi.fn().mockResolvedValue({data: []});
    const model = createTestModel();
    appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
    appServer.accountLogout = vi.fn().mockResolvedValue({});
    appServer.threadResume = vi.fn().mockResolvedValue({
        thread: {id: SESSION_ID, historyMode: "paginated", turns: [], cwd: "/test/project", name: null, preview: ""},
        itemsBackwardsCursor: "item:last",
        model: model.id,
        modelProvider: "openai",
        cwd: "/test/project",
        approvalPolicy: "never",
        sandbox: {type: "dangerFullAccess"},
        reasoningEffort: model.defaultReasoningEffort,
    });
    appServer.threadItemsList = vi.fn().mockResolvedValue({
        data: [{turnId: "turn-1", item: {type: "agentMessage", id: "m-1", text: "history", phase: null, memoryCitation: null, delivery: null, questions: null}}],
        nextCursor: null,
        backwardsCursor: null,
    });
    const metadata = {
        sessionId: SESSION_ID,
        currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
        models: [model],
        collaborationMode: "default" as const,
        modelProvider: "openai",
        additionalDirectories: [],
    };
    vi.spyOn(client, "newSession").mockResolvedValue(metadata);
    vi.spyOn(client, "resumeSession").mockResolvedValue(metadata);
    return fixture;
}

async function initialize(fixture: CodexMockTestFixture): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
    await drainScheduledWork();
}

describe("CodexACPAgent - an unavailable account read", () => {
    it("loads the session and streams the history, with no auth status and no logout", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockRejectedValue(routingFailure());
        await initialize(fixture);

        await fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await drainScheduledWork();

        expect(historyTexts(fixture)).toEqual(["history"]);
        expect(authStatusUpdates(fixture)).toEqual([]);
        expect(appServer.accountLogout).not.toHaveBeenCalled();
        // One read for `initialize`, and one read for the load.
        expect(appServer.accountRead).toHaveBeenCalledTimes(2);
    });

    it("keeps the last auth status and the last account when the read fails later", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValueOnce(SIGNED_IN).mockResolvedValueOnce(SIGNED_IN);
        await initialize(fixture);
        await fixture.getCodexAcpAgent().newSession({cwd: "/test/project", mcpServers: []});
        await fixture.getCodexAcpAgent().closeSession({sessionId: SESSION_ID});
        const before = authStatusUpdates(fixture);
        appServer.accountRead = vi.fn().mockRejectedValue(routingFailure());

        await fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await drainScheduledWork();

        expect(before).toEqual([{kind: "account", label: "ChatGPT Plus", account: {email: "user@example.com", plan: "plus"}}]);
        expect(authStatusUpdates(fixture)).toEqual(before);
        expect(fixture.getCodexAcpAgent().getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it.each(["new", "resume"] as const)("opens a session with session/%s, with no auth status and no logout", async operation => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockRejectedValue(routingFailure());
        await initialize(fixture);

        const agent = fixture.getCodexAcpAgent();
        const response = operation === "new"
            ? await agent.newSession({cwd: "/test/project", mcpServers: []})
            : await agent.resumeSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        await drainScheduledWork();

        expect(response).toBeDefined();
        expect(agent.getSessionState(SESSION_ID)).toBeDefined();
        expect(authStatusUpdates(fixture)).toEqual([]);
        expect(appServer.accountLogout).not.toHaveBeenCalled();
        // One read for `initialize`, and one read for the session open.
        expect(appServer.accountRead).toHaveBeenCalledTimes(2);
    });

    it("lists the sessions", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockRejectedValue(routingFailure());
        appServer.threadList = vi.fn().mockResolvedValue({data: [], nextCursor: null});
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().listSessions({cwd: "/test/project"})).resolves.toMatchObject({sessions: []});
    });

    describe("a read that ends after the grace time of the load", () => {
        beforeEach(() => {
            // Only the grace timer and its clock are fake. The JSON-RPC layer and `drainScheduledWork` use `setImmediate`.
            vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "performance"]});
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("answers the load after the grace time, and applies the read later", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockRejectedValueOnce(routingFailure())
                .mockImplementation(read.start);
            await initialize(fixture);

            await loadAfterGrace(fixture);

            expect(historyTexts(fixture)).toEqual(["history"]);
            expect(authStatusUpdates(fixture)).toEqual([]);

            read.resolve(SIGNED_IN);
            await drainScheduledWork();
            expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS]);
            expect(fixture.getCodexAcpAgent().getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
        });

        it("pushes the none status at once when a late read finds a revoked token (401)", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockResolvedValueOnce(SIGNED_IN)
                .mockImplementationOnce(read.start)
                .mockRejectedValue(unauthorized());
            await initialize(fixture);
            const agent = fixture.getCodexAcpAgent();

            await loadAfterGrace(fixture);
            expect(agent.getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);

            read.reject(unauthorized());
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS, NONE_STATUS]);
            expect(agent.getSessionState(SESSION_ID).account).toBeNull();
            // One read for `initialize` and one read for the load: the 401 needs no second read.
            expect(appServer.accountRead).toHaveBeenCalledTimes(2);
            expect(appServer.accountLogout).not.toHaveBeenCalled();
        });

        it("pushes the none status when a late read finds no login (a defensive case)", async () => {
            // A missing login needs no network call, so its read is fast. The case covers a slow app-server.
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockRejectedValueOnce(routingFailure())
                .mockImplementationOnce(read.start);
            await initialize(fixture);

            await loadAfterGrace(fixture);
            read.resolve({account: null, requiresOpenaiAuth: true});
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([NONE_STATUS]);
            expect(appServer.accountRead).toHaveBeenCalledTimes(2);
        });

        it("keeps the status and the account when a late read fails with another error", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockResolvedValueOnce(SIGNED_IN)
                .mockImplementationOnce(read.start);
            await initialize(fixture);
            const agent = fixture.getCodexAcpAgent();

            await loadAfterGrace(fixture);
            read.reject(new ResponseError(-32603, "duplicate workspace in routing discovery"));
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS]);
            expect(agent.getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
            expect(appServer.accountRead).toHaveBeenCalledTimes(2);
        });

        it("reads the account again when another client changed the login while the late read ran", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockRejectedValueOnce(routingFailure())
                .mockImplementationOnce(read.start)
                .mockResolvedValue(SIGNED_IN);
            await initialize(fixture);

            await loadAfterGrace(fixture);
            read.reject(new ResponseError(-32603, "account changed during workspace routing discovery"));
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS]);
            expect(appServer.accountRead).toHaveBeenCalledTimes(3);
        });

        it("pushes nothing when the session closes before the late read ends", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockRejectedValueOnce(routingFailure())
                .mockImplementationOnce(read.start);
            await initialize(fixture);
            const agent = fixture.getCodexAcpAgent();

            await loadAfterGrace(fixture);
            await agent.closeSession({sessionId: SESSION_ID});
            read.resolve(SIGNED_IN);
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([]);
        });

        it("applies only the newest answer when the session loads twice", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const firstRead = pendingRead();
            const secondRead = pendingRead();
            appServer.accountRead = vi.fn()
                .mockRejectedValueOnce(routingFailure())
                .mockImplementationOnce(firstRead.start)
                .mockImplementationOnce(secondRead.start);
            await initialize(fixture);
            const agent = fixture.getCodexAcpAgent();

            await loadAfterGrace(fixture);
            const firstState = agent.getSessionState(SESSION_ID);
            await loadAfterGrace(fixture);
            const secondState = agent.getSessionState(SESSION_ID);
            expect(secondState).not.toBe(firstState);

            secondRead.resolve(SIGNED_IN);
            await drainScheduledWork();
            firstRead.resolve({account: {type: "apiKey"}, requiresOpenaiAuth: true} as GetAccountResponse);
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS]);
            expect(agent.getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
            expect(firstState.account).toBeNull();
        });

        it("drops a late answer when a newer auth status came after the read started", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockResolvedValueOnce(SIGNED_IN)
                .mockImplementationOnce(read.start);
            await initialize(fixture);
            const agent = fixture.getCodexAcpAgent();

            await loadAfterGrace(fixture);
            agent.handleAccountUpdated({authMode: "apikey", planType: null});
            await drainScheduledWork();
            read.resolve(SIGNED_IN);
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS, {kind: "api_key", label: "OpenAI API key"}]);
        });

        it("fails the load with the resume error after the grace time when the read is still pending", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            const read = pendingRead();
            appServer.accountRead = vi.fn()
                .mockRejectedValueOnce(routingFailure())
                .mockImplementationOnce(read.start);
            vi.spyOn(fixture.getCodexAcpClient(), "loadSession").mockRejectedValue(new Error("resume failed"));
            await initialize(fixture);

            const load = fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
            const outcome = load.then(() => "answered", (error: Error) => error.message);
            await vi.advanceTimersByTimeAsync(ACCOUNT_READ_LOAD_GRACE_MS - 1);
            await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("pending");
            await vi.advanceTimersByTimeAsync(1);

            await expect(outcome).resolves.toBe("resume failed");
            read.reject(unauthorized());
            await drainScheduledWork();
        });
    });

    it("fails the load with the auth error when the resume fails and the read fails fast", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockRejectedValue(unauthorized());
        vi.spyOn(fixture.getCodexAcpClient(), "loadSession").mockRejectedValue(new Error("resume failed"));
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toThrow("workspace routing discovery unauthorized (401)");
    });

    it("keeps the sessions and pushes nothing when an auth refresh read is unavailable", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValueOnce(SIGNED_IN).mockResolvedValueOnce(SIGNED_IN);
        await initialize(fixture);
        const agent = fixture.getCodexAcpAgent();
        await agent.newSession({cwd: "/test/project", mcpServers: []});
        appServer.accountRead = vi.fn().mockRejectedValue(routingFailure());

        await (agent as unknown as {refreshAuthState(provider: string | null): Promise<void>}).refreshAuthState(null);

        expect(authStatusUpdates(fixture)).toEqual([SIGNED_IN_STATUS]);
        expect(agent.getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it("pushes the none status when the first auth status read finds a revoked token", async () => {
        const fixture = fixtureWithSession();
        fixture.getCodexAppServerClient().accountRead = vi.fn().mockRejectedValue(unauthorized());

        await initialize(fixture);

        expect(authStatusUpdates(fixture)).toEqual([NONE_STATUS]);
    });

    it("opens a session with the account of account/updated when the read is unavailable", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockResolvedValueOnce(SIGNED_IN).mockRejectedValue(routingFailure());
        await initialize(fixture);
        const agent = fixture.getCodexAcpAgent();

        agent.handleAccountUpdated({authMode: null, planType: null});
        await drainScheduledWork();
        await agent.newSession({cwd: "/test/project", mcpServers: []});

        expect(agent.getSessionState(SESSION_ID).account).toBeNull();
    });

    describe("authentication/status", () => {
        it("answers the last known ChatGPT account when the read is unavailable", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            appServer.accountRead = vi.fn().mockResolvedValueOnce(SIGNED_IN).mockRejectedValue(routingFailure());
            appServer.configRead = vi.fn().mockResolvedValue({config: {}});
            await initialize(fixture);

            await expect(fixture.getCodexAcpAgent().extMethod("authentication/status", {}))
                .resolves.toEqual({type: "chat-gpt", email: "user@example.com"});
        });

        it("answers unauthenticated when the read finds a revoked token", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            appServer.accountRead = vi.fn().mockRejectedValue(unauthorized());
            appServer.configRead = vi.fn().mockResolvedValue({config: {}});
            await initialize(fixture);

            await expect(fixture.getCodexAcpAgent().extMethod("authentication/status", {}))
                .resolves.toEqual({type: "unauthenticated"});
        });
    });

    describe("authenticate with a stored ChatGPT login", () => {
        const deviceCodeRequest = {methodId: "chat-gpt-device-code"};

        it("keeps the stored login when the read is unavailable", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            appServer.accountRead = vi.fn().mockRejectedValue(routingFailure());
            appServer.accountLogin = vi.fn();

            await expect(fixture.getCodexAcpClient().authenticate(deviceCodeRequest)).resolves.toBe(true);
            expect(appServer.accountLogin).not.toHaveBeenCalled();
        });

        it("starts a new login when the read finds a revoked token", async () => {
            const fixture = fixtureWithSession();
            const appServer = fixture.getCodexAppServerClient();
            appServer.accountRead = vi.fn().mockRejectedValue(unauthorized());

            // Without URL elicitation the device code login stops at its first step, after the read.
            await expect(fixture.getCodexAcpClient().authenticate(deviceCodeRequest))
                .rejects.toThrow("Device code authentication requires URL elicitation support");
        });
    });

    it("fails the load with the error of a refused token, as before", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockRejectedValue(new ResponseError(-32603, "workspace routing discovery unauthorized (401)"));
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toThrow("workspace routing discovery unauthorized (401)");
        // The read of `initialize` pushes the none status. The load pushes nothing more.
        expect(authStatusUpdates(fixture)).toEqual([NONE_STATUS]);
        expect(appServer.accountLogout).not.toHaveBeenCalled();
    });
});
