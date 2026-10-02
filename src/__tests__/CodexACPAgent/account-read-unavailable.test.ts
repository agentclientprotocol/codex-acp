import {describe, expect, it, vi} from "vitest";
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

    it("answers the load after the grace time when the read waits for the backend, and applies the read later", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockRejectedValueOnce(routingFailure())
            .mockImplementation(() => new Promise<GetAccountResponse>(resolve => answer = resolve));
        await initialize(fixture);

        const started = performance.now();
        await fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        const elapsed = performance.now() - started;

        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(5_000);
        expect(historyTexts(fixture)).toEqual(["history"]);
        expect(authStatusUpdates(fixture)).toEqual([]);

        answer(SIGNED_IN);
        await vi.waitFor(() => expect(authStatusUpdates(fixture)).toHaveLength(1));
        expect(authStatusUpdates(fixture)[0]).toMatchObject({kind: "account"});
        expect(fixture.getCodexAcpAgent().getSessionState(SESSION_ID).account).toEqual(SIGNED_IN.account);
    });

    it("pushes the none status when a late read finds that the agent needs a login", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        let answer: (response: GetAccountResponse) => void = () => {};
        appServer.accountRead = vi.fn()
            .mockRejectedValueOnce(routingFailure())
            .mockImplementationOnce(() => new Promise<GetAccountResponse>(resolve => answer = resolve))
            .mockResolvedValue({account: null, requiresOpenaiAuth: true});
        await initialize(fixture);

        await fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []});
        expect(authStatusUpdates(fixture)).toEqual([]);

        answer({account: null, requiresOpenaiAuth: true});
        await vi.waitFor(() => expect(authStatusUpdates(fixture)).toHaveLength(1));
        expect(authStatusUpdates(fixture)[0]).toMatchObject({kind: "none"});
        expect(appServer.accountLogout).not.toHaveBeenCalled();
    });

    it("fails the load with the error of a refused token, as before", async () => {
        const fixture = fixtureWithSession();
        const appServer = fixture.getCodexAppServerClient();
        appServer.accountRead = vi.fn().mockRejectedValue(new ResponseError(-32603, "workspace routing discovery unauthorized (401)"));
        await initialize(fixture);

        await expect(fixture.getCodexAcpAgent().loadSession({sessionId: SESSION_ID, cwd: "/test/project", mcpServers: []}))
            .rejects.toThrow("workspace routing discovery unauthorized (401)");
        expect(authStatusUpdates(fixture)).toEqual([]);
        expect(appServer.accountLogout).not.toHaveBeenCalled();
    });
});
