import {describe, expect, it, vi} from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    createTestSessionState,
    mockPromptTurn,
    type CodexMockTestFixture,
    type MethodCallEvent,
} from "../acp-test-utils";
import {
    AUTH_STATUS_META_KEY,
    AUTH_STATUS_UPDATE_METHOD,
    type AuthStatus,
} from "../../AuthStatusMeta";
import {ModelId} from "../../ModelId";
import {PROTOCOL_VERSION} from "@agentclientprotocol/sdk";
import {CodexEventHandler} from "../../CodexEventHandler";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import type {Account, AccountUpdatedNotification} from "../../app-server/v2";

const CHAT_GPT_PLUS: AuthStatus = {
    kind: "account",
    label: "ChatGPT Plus",
    account: {email: "user@example.com", plan: "plus"},
};

function authStatusUpdates(fixture: CodexMockTestFixture): AuthStatus[] {
    return fixture.getAcpConnectionEvents([])
        .filter((event: MethodCallEvent) => event.method === "notify" && event.args[0] === AUTH_STATUS_UPDATE_METHOD)
        .map((event: MethodCallEvent) => (event.args[1] as {authStatus: AuthStatus}).authStatus);
}

function mockAccount(fixture: CodexMockTestFixture, account: Account | null) {
    return vi.spyOn(fixture.getCodexAcpClient(), "getAccount").mockResolvedValue({
        account,
        requiresOpenaiAuth: account === null,
    });
}

/** Waits for the fire-and-forget publishes of `initialize` and `account/updated`. */
async function awaitAuthStatusUpdates(fixture: CodexMockTestFixture, count: number): Promise<AuthStatus[]> {
    await vi.waitFor(() => expect(authStatusUpdates(fixture)).toHaveLength(count));
    return authStatusUpdates(fixture);
}

/**
 * Lets every already-scheduled callback run, so that "nothing was pushed" is a
 * verdict and not a race. Once its source is mocked, the identity read is a
 * fixed, short chain of scheduled work.
 */
async function drainScheduledWork(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

/** `initialize`, plus the first push it starts. */
async function initializeAndAwaitFirstPush(fixture: CodexMockTestFixture): Promise<AuthStatus> {
    await fixture.getCodexAcpAgent().initialize({protocolVersion: PROTOCOL_VERSION});
    const [first] = await awaitAuthStatusUpdates(fixture, 1);
    return first!;
}

/** A session whose prompts complete immediately, to exercise turn boundaries. */
async function createPromptableSession(fixture: CodexMockTestFixture): Promise<string> {
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const model = createTestModel();
    vi.spyOn(client, "authRequired").mockResolvedValue(false);
    vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(client, "newSession").mockResolvedValue({
        sessionId: "turn-session",
        currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
        models: [model],
        collaborationMode: "default",
        additionalDirectories: [],
    });
    const session = await agent.newSession({cwd: "/workspace", mcpServers: []});
    mockPromptTurn(fixture, session.sessionId);
    return session.sessionId;
}

/** The `gateway` auth method: agent-owned gateway authentication. */
function gatewayAuthRequest(providerName: string) {
    return {
        methodId: "gateway",
        _meta: {
            gateway: {
                baseUrl: "https://gateway.example.com/v1",
                providerName,
            },
        },
    };
}

describe("authStatus extension", () => {
    describe("capability marker", () => {
        it("is advertised in the initialize response, without a payload", async () => {
            const fixture = createCodexMockTestFixture();

            const response = await fixture.getCodexAcpAgent().initialize({protocolVersion: PROTOCOL_VERSION});

            expect(response.agentCapabilities?._meta?.[AUTH_STATUS_META_KEY]).toEqual({});
            expect(response._meta?.[AUTH_STATUS_META_KEY]).toBeUndefined();
        });
    });

    describe("first push after initialize", () => {
        it("follows the initialize response and reports the account", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});

            await fixture.getCodexAcpAgent().initialize({protocolVersion: PROTOCOL_VERSION});

            // The response is ready to go out and nothing has been pushed yet, so the
            // client can never see the identity before it knows the agent pushes one.
            expect(authStatusUpdates(fixture)).toEqual([]);
            expect(await awaitAuthStatusUpdates(fixture, 1)).toEqual([CHAT_GPT_PLUS]);
        });

        it("reports an API key account", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, {type: "apiKey"});

            expect(await initializeAndAwaitFirstPush(fixture))
                .toEqual({kind: "api_key", label: "OpenAI API key"});
        });

        it("reports Bedrock as external auth", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, {type: "amazonBedrock", usesCodexManagedCredentials: false});

            expect(await initializeAndAwaitFirstPush(fixture))
                .toEqual({kind: "external", label: "AWS Bedrock"});
        });

        it("reports a logged-out agent as kind none", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, null);

            // The first push is unconditional: a known logged-out state is news too.
            expect(await initializeAndAwaitFirstPush(fixture))
                .toEqual({kind: "none", label: "Not logged in"});
        });

        it("reports gateway for a provider configured in Codex's own config", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});
            vi.spyOn(fixture.getCodexAcpClient(), "getAgentConfiguredModelProvider")
                .mockResolvedValue("custom-provider");

            expect(await initializeAndAwaitFirstPush(fixture))
                .toEqual({kind: "gateway", label: "Custom model gateway", detail: "custom-provider"});
        });

        it("ignores routing the client configured through the providers API", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});

            await agent.setProvider({
                providerId: "openai",
                apiType: "openai",
                baseUrl: "https://gateway.example.com/v1",
            });

            expect(await initializeAndAwaitFirstPush(fixture)).toEqual(CHAT_GPT_PLUS);
        });

        it("capitalizes unknown plan values and omits the unknown plan marker", async () => {
            const rawPlanFixture = createCodexMockTestFixture();
            mockAccount(rawPlanFixture, {type: "chatgpt", email: null, planType: "prolite"});
            expect(await initializeAndAwaitFirstPush(rawPlanFixture)).toEqual({
                kind: "account",
                label: "ChatGPT Prolite",
                account: {plan: "prolite"},
            });

            const unknownPlanFixture = createCodexMockTestFixture();
            mockAccount(unknownPlanFixture, {type: "chatgpt", email: null, planType: "unknown"});
            expect(await initializeAndAwaitFirstPush(unknownPlanFixture)).toEqual({
                kind: "account",
                label: "ChatGPT",
                account: {plan: "unknown"},
            });
        });

        it("keeps the plan the legacy authentication/status method drops", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "business"});

            const legacy = await fixture.getCodexAcpAgent().extMethod("authentication/status", {});
            expect(legacy).toEqual({type: "chat-gpt", email: "user@example.com"});

            const authStatus = await initializeAndAwaitFirstPush(fixture);
            expect(authStatus.label).toBe("ChatGPT Business");
            expect(authStatus.account).toEqual({email: "user@example.com", plan: "business"});
        });

        it("pushes nothing when the identity cannot be read", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "getAccount")
                .mockRejectedValue(new Error("app-server is gone"));

            await fixture.getCodexAcpAgent().initialize({protocolVersion: PROTOCOL_VERSION});
            await drainScheduledWork();

            // An agent that cannot learn its identity says nothing, and the client
            // shows "not reported" instead of an invented state.
            expect(authStatusUpdates(fixture)).toEqual([]);
        });
    });

    describe("_auth/status_update notification", () => {
        it("is sent after a successful authenticate", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "pro"});

            await fixture.getCodexAcpAgent().authenticate({methodId: "chat-gpt"});

            expect(authStatusUpdates(fixture)).toEqual([{
                kind: "account",
                label: "ChatGPT Pro",
                account: {email: "user@example.com", plan: "pro"},
            }]);
        });

        it("reports the agent-owned login while client-driven routing is active", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});

            await agent.setProvider({
                providerId: "openai",
                apiType: "openai",
                baseUrl: "https://gateway.example.com/v1",
            });
            await agent.authenticate({methodId: "chat-gpt"});

            expect(authStatusUpdates(fixture)).toEqual([CHAT_GPT_PLUS]);
        });

        it("is sent after a logout", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            vi.spyOn(fixture.getCodexAcpClient(), "logout").mockResolvedValue();
            const accountSpy = mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "pro"});

            await agent.authenticate({methodId: "chat-gpt"});
            accountSpy.mockResolvedValue({account: null, requiresOpenaiAuth: true});
            await agent.logout({});

            expect(authStatusUpdates(fixture)).toEqual([
                {
                    kind: "account",
                    label: "ChatGPT Pro",
                    account: {email: "user@example.com", plan: "pro"},
                },
                {kind: "none", label: "Not logged in"},
            ]);
        });

        it("is sent when the app-server pushes account/updated", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});
            const agent = fixture.getCodexAcpAgent();

            await agent.authenticate({methodId: "chat-gpt"});
            agent.handleAccountUpdated({authMode: "chatgpt", planType: "pro"});

            expect(await awaitAuthStatusUpdates(fixture, 2)).toEqual([
                CHAT_GPT_PLUS,
                {
                    // The push carries no email; the last known one survives an unchanged kind.
                    kind: "account",
                    label: "ChatGPT Pro",
                    account: {email: "user@example.com", plan: "pro"},
                },
            ]);
        });

        it("drops the last known email when the account kind changes", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});
            const agent = fixture.getCodexAcpAgent();

            await agent.authenticate({methodId: "chat-gpt"});
            agent.handleAccountUpdated({authMode: "apikey", planType: null});

            expect((await awaitAuthStatusUpdates(fixture, 2)).at(-1)).toEqual({
                kind: "api_key",
                label: "OpenAI API key",
            });
        });

        it("maps the bedrockAccessKeys auth mode to external Bedrock", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});
            const agent = fixture.getCodexAcpAgent();

            await agent.authenticate({methodId: "chat-gpt"});
            agent.handleAccountUpdated({authMode: "bedrockAccessKeys", planType: null});

            expect((await awaitAuthStatusUpdates(fixture, 2)).at(-1)).toEqual({
                kind: "external",
                label: "AWS Bedrock",
            });
        });

        it("is not sent again while the identity is unchanged", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});
            const agent = fixture.getCodexAcpAgent();

            // Four reads of the same login: two authenticates, the `initialize` read,
            // and an account push.
            await agent.authenticate({methodId: "chat-gpt"});
            await agent.authenticate({methodId: "chat-gpt"});
            await agent.initialize({protocolVersion: PROTOCOL_VERSION});
            agent.handleAccountUpdated({authMode: "chatgpt", planType: "plus"});
            await drainScheduledWork();

            expect(authStatusUpdates(fixture)).toEqual([CHAT_GPT_PLUS]);
        });

        it("is sent again once the identity actually changes", async () => {
            const fixture = createCodexMockTestFixture();
            vi.spyOn(fixture.getCodexAcpClient(), "authenticate").mockResolvedValue(true);
            const accountSpy = mockAccount(
                fixture,
                {type: "chatgpt", email: "user@example.com", planType: "plus"},
            );
            const agent = fixture.getCodexAcpAgent();

            await agent.authenticate({methodId: "chat-gpt"});
            accountSpy.mockResolvedValue({
                account: {type: "chatgpt", email: "user@example.com", planType: "pro"},
                requiresOpenaiAuth: false,
            });
            await agent.authenticate({methodId: "chat-gpt"});

            expect(authStatusUpdates(fixture)).toEqual([
                CHAT_GPT_PLUS,
                {
                    kind: "account",
                    label: "ChatGPT Pro",
                    account: {email: "user@example.com", plan: "pro"},
                },
            ]);
        });

        it("keeps the gateway status when an account event arrives", async () => {
            const fixture = createCodexMockTestFixture();
            mockAccount(fixture, {type: "chatgpt", email: "user@example.com", planType: "plus"});
            const agent = fixture.getCodexAcpAgent();

            await agent.authenticate(gatewayAuthRequest("ACME Gateway"));
            agent.handleAccountUpdated({authMode: "chatgpt", planType: "pro"});
            agent.handleAccountUpdated({authMode: null, planType: null});
            await drainScheduledWork();

            // The account push says nothing about gateway authentication, so it is ignored.
            expect(authStatusUpdates(fixture))
                .toEqual([{kind: "gateway", label: "Custom model gateway", detail: "ACME Gateway"}]);
        });
    });

    describe("freshness", () => {
        it("does not re-read the identity on a turn", async () => {
            const fixture = createCodexMockTestFixture();
            const accountSpy = mockAccount(
                fixture,
                {type: "chatgpt", email: "user@example.com", planType: "plus"},
            );
            const sessionId = await createPromptableSession(fixture);
            accountSpy.mockClear();

            await fixture.getCodexAcpAgent().prompt({
                sessionId,
                prompt: [{type: "text", text: "hello"}],
            });
            await awaitAuthStatusUpdates(fixture, 1);

            // A login or a logout made elsewhere arrives as `account/updated`, so a
            // turn buys nothing by reading the account again.
            expect(accountSpy).not.toHaveBeenCalled();
        });

        it("reports an out-of-band login through the account/updated push", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();
            mockAccount(fixture, null);
            await createPromptableSession(fixture);
            await awaitAuthStatusUpdates(fixture, 1);

            // Someone logs in from another terminal while this connection is idle.
            agent.handleAccountUpdated({authMode: "chatgpt", planType: "pro"});

            expect(await awaitAuthStatusUpdates(fixture, 2)).toEqual([
                {kind: "none", label: "Not logged in"},
                {kind: "account", label: "ChatGPT Pro", account: {plan: "pro"}},
            ]);
        });
    });

    describe("account/updated event routing", () => {
        it("forwards the app-server notification to the connection-level sink", async () => {
            const received: AccountUpdatedNotification[] = [];
            const connection = {
                notify: vi.fn(async () => {}),
                request: vi.fn(),
            } as unknown as AcpClientConnection;
            const handler = new CodexEventHandler(
                connection,
                createTestSessionState(),
                false,
                false,
                "epoch",
                undefined,
                (notification: AccountUpdatedNotification) => received.push(notification),
            );

            await handler.handleNotification({
                method: "account/updated",
                params: {authMode: "chatgpt", planType: "plus"},
            });

            expect(received).toEqual([{authMode: "chatgpt", planType: "plus"}]);
        });
    });
});
