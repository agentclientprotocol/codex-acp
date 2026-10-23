import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    createCodexMockTestFixture,
    createTestModel,
    createTestSessionState,
    deferred,
    mockPromptTurn,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import {OPENAI_PROVIDER_ID} from "../../CodexAcpClient";
import {MODEL_CONFIG_ID} from "../../ModelConfigOption";
import type {Model} from "../../app-server/v2";

const GATEWAY = {
    providerId: OPENAI_PROVIDER_ID,
    apiType: "openai",
    baseUrl: "https://gateway.example/v1/",
    headers: {Authorization: "Bearer secret"},
} as const;

const highEffort = {reasoningEffort: "high", description: "Thorough"} as const;

function codexModels(): Model[] {
    return [
        createTestModel({id: "gpt-5.5", isDefault: true, supportedReasoningEfforts: [highEffort], defaultReasoningEffort: "high"}),
        createTestModel({id: "gpt-5.4", isDefault: false}),
        createTestModel({id: "mini", model: "gpt-5.4-mini", isDefault: false}),
        createTestModel({id: "gpt-5.3-codex", isDefault: false}),
    ];
}

function listing(ids: string[]): Response {
    return Response.json({object: "list", data: ids.map(id => ({id, object: "model"}))});
}

function createFixture(
    models: Model[] = codexModels(),
    restartCodexClient?: Parameters<typeof createCodexMockTestFixture>[0],
): CodexMockTestFixture {
    const fixture = createCodexMockTestFixture(restartCodexClient);
    const appServer = fixture.getCodexAppServerClient();
    vi.spyOn(appServer, "listModels").mockResolvedValue({data: models, nextCursor: null});
    vi.spyOn(fixture.getCodexAcpClient(), "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(fixture.getCodexAcpClient(), "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    return fixture;
}

async function openSession(fixture: CodexMockTestFixture, threadModel: string) {
    vi.spyOn(fixture.getCodexAppServerClient(), "threadStart").mockResolvedValue({
        thread: {id: "thread-id"},
        model: threadModel,
        modelProvider: "custom-gateway",
        reasoningEffort: "high",
        serviceTier: null,
    } as never);
    return await fixture.getCodexAcpAgent().newSession({cwd: "/workspace", mcpServers: []});
}

function modelOptionValues(response: Awaited<ReturnType<typeof openSession>>): string[] {
    const option = response.configOptions?.find(o => o.id === MODEL_CONFIG_ID);
    return (option as {options: Array<{value: string}>}).options.map(o => o.value);
}

describe("Gateway model discovery (providers/set)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("lists the gateway models with the headers Codex sends", async () => {
        fetchMock.mockResolvedValue(listing(["gpt-5.4"]));
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().setProvider(GATEWAY);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith("https://gateway.example/v1/models", {
            method: "GET",
            headers: {
                "X-Client-Feature-ID": "codex",
                "Authorization": "Bearer secret",
                "Accept": "application/json",
            },
            signal: expect.any(AbortSignal),
        });
    });

    it("narrows the models to the listed ones, ignoring case and date suffixes, with one default", async () => {
        fetchMock.mockResolvedValue(listing(["GPT-5.4-2026-03-05", "gpt-5.4-mini-20260305", "unknown-model"]));
        const fixture = createFixture();
        await fixture.getCodexAcpAgent().setProvider(GATEWAY);

        const models = await fixture.getCodexAcpClient().fetchAvailableModels();

        expect(models.map(m => [m.id, m.isDefault])).toEqual([["gpt-5.4", true], ["mini", false]]);
        await expect(JSON.stringify(models, null, 2)).toMatchFileSnapshot("data/gateway-model-discovery-narrowed.json");
    });

    it("reports the narrowed models in a new session", async () => {
        fetchMock.mockResolvedValue(listing(["gpt-5.4", "gpt-5.4-mini"]));
        const fixture = createFixture();
        await fixture.getCodexAcpAgent().setProvider(GATEWAY);

        const response = await openSession(fixture, "gpt-5.4");

        expect(modelOptionValues(response)).toEqual(["gpt-5.4", "mini"]);
        expect(fixture.getCodexAcpAgent().getSessionState(response.sessionId).currentModelId).toBe("gpt-5.4[high]");
    });

    it("replaces a thread model the gateway does not list with the narrowed default, also on turn/start", async () => {
        fetchMock.mockResolvedValue(listing(["gpt-5.4", "gpt-5.4-mini"]));
        const fixture = createFixture();
        await fixture.getCodexAcpAgent().setProvider(GATEWAY);

        const response = await openSession(fixture, "gpt-5.5");

        const option = response.configOptions?.find(o => o.id === MODEL_CONFIG_ID);
        expect(option?.currentValue).toBe("gpt-5.4");
        expect(modelOptionValues(response)).toEqual(["gpt-5.4", "mini"]);
        // gpt-5.4 does not support the thread's `high` effort, so it takes its own default.
        expect(fixture.getCodexAcpAgent().getSessionState(response.sessionId).currentModelId).toBe("gpt-5.4[medium]");

        const turnStart = mockPromptTurn(fixture, response.sessionId);
        await fixture.getCodexAcpAgent().prompt({sessionId: response.sessionId, prompt: [{type: "text", text: "hi"}]});
        expect(turnStart).toHaveBeenCalledWith(expect.objectContaining({model: "gpt-5.4", effort: "medium"}));
    });

    it("keeps a thread model that the gateway lists but Codex does not know", async () => {
        fetchMock.mockResolvedValue(listing(["gpt-5.4", "gpt-6.1-sol"]));
        const fixture = createFixture();
        await fixture.getCodexAcpAgent().setProvider(GATEWAY);

        const response = await openSession(fixture, "gpt-6.1-sol");

        expect(response.configOptions?.find(o => o.id === MODEL_CONFIG_ID)?.currentValue).toBe("gpt-6.1-sol");
        expect(modelOptionValues(response)).toEqual(["gpt-6.1-sol", "gpt-5.4"]);
        expect(fixture.getCodexAcpAgent().getSessionState(response.sessionId).currentModelId).toBe("gpt-6.1-sol[high]");
    });

    it.each([
        ["a 5xx status", () => new Response("unavailable", {status: 503}), "Model listing GET /v1/models returned 503: unavailable"],
        ["a malformed body", () => Response.json({models: ["gpt-5.4"]}), "Model listing GET /v1/models returned a malformed body"],
        ["a network error", () => { throw new TypeError("fetch failed"); }, "Model listing GET /v1/models failed: fetch failed"],
    ])("fails providers/set and keeps the current routing after %s", async (_name, answer, reason) => {
        fetchMock.mockImplementation(async () => answer());
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();

        await expect(agent.setProvider(GATEWAY)).rejects.toMatchObject({
            code: -32603,
            message: expect.stringContaining(reason),
        });

        expect(fixture.getCodexAcpClient().listProviders()[0]?.current?.baseUrl).not.toBe(GATEWAY.baseUrl);
        expect(await fixture.getCodexAcpClient().fetchAvailableModels()).toEqual(codexModels());
    });

    it("fails providers/set without the value of an invalid header", async () => {
        const fixture = createFixture();

        const error = await fixture.getCodexAcpAgent().setProvider({...GATEWAY, headers: {Authorization: "Bearer secret\nx"}})
            .then(() => null, (e: acp.RequestError) => e);

        expect(error?.code).toBe(-32603);
        expect(error?.message).toContain('Model listing GET /v1/models failed: the header "Authorization" is invalid');
        expect(error?.message).not.toContain("secret");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails providers/set without the credentials of a base URL that carries them", async () => {
        const fixture = createFixture();

        const error = await fixture.getCodexAcpAgent().setProvider({...GATEWAY, baseUrl: "https://user:pw@gateway.example/v1"})
            .then(() => null, (e: acp.RequestError) => e);

        expect(error?.code).toBe(-32603);
        expect(error?.message).toContain("Model listing GET /v1/models failed: the base URL carries credentials");
        expect(error?.message).not.toContain("user:pw");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("drops a listing that a providers/disable overtook", async () => {
        const listed = deferred<Response>();
        fetchMock.mockReturnValue(listed.promise);
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();

        const set = agent.setProvider(GATEWAY);
        await agent.disableProvider({providerId: OPENAI_PROVIDER_ID});
        listed.resolve(listing(["gpt-5.4"]));
        await set;

        expect(fixture.getCodexAcpClient().listProviders()[0]?.current?.baseUrl).toBe("https://api.openai.com/v1");
        expect(await fixture.getCodexAcpClient().fetchAvailableModels()).toEqual(codexModels());
    });

    it("drops a listing that a newer providers/set overtook", async () => {
        const firstListed = deferred<Response>();
        fetchMock.mockReturnValueOnce(firstListed.promise).mockResolvedValueOnce(listing(["gpt-5.3-codex"]));
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();

        const first = agent.setProvider(GATEWAY);
        await agent.setProvider({...GATEWAY, baseUrl: "https://other.example/v1"});
        firstListed.resolve(listing(["gpt-5.4"]));
        await first;

        expect(fixture.getCodexAcpClient().listProviders()[0]?.current?.baseUrl).toBe("https://other.example/v1");
        expect((await fixture.getCodexAcpClient().fetchAvailableModels()).map(m => m.id)).toEqual(["gpt-5.3-codex"]);
    });

    it("applies a listing that a newer providers/set failing overtook", async () => {
        const firstListed = deferred<Response>();
        fetchMock.mockReturnValueOnce(firstListed.promise).mockResolvedValueOnce(new Response("unavailable", {status: 503}));
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();

        const first = agent.setProvider(GATEWAY);
        await expect(agent.setProvider({...GATEWAY, baseUrl: "https://other.example/v1"})).rejects.toThrow();
        await expect(agent.setProvider({...GATEWAY, baseUrl: "localhost:8080/v1"})).rejects.toMatchObject({code: -32602});
        firstListed.resolve(listing(["gpt-5.4"]));
        await first;

        expect(fixture.getCodexAcpClient().listProviders()[0]?.current?.baseUrl).toBe(GATEWAY.baseUrl);
        expect((await fixture.getCodexAcpClient().fetchAvailableModels()).map(m => m.id)).toEqual(["gpt-5.4"]);
    });

    it.each(["localhost:8080/v1", "file:///tmp/models", "ws://gateway.example/v1"])(
        "rejects the non-http base URL %s with invalid_params",
        async (baseUrl) => {
            const fixture = createFixture();

            await expect(fixture.getCodexAcpAgent().setProvider({...GATEWAY, baseUrl})).rejects.toMatchObject({code: -32602});
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it("keeps the previous gateway when setting another one fails to list", async () => {
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();
        fetchMock.mockResolvedValueOnce(listing(["gpt-5.4"]));
        await agent.setProvider(GATEWAY);
        fetchMock.mockResolvedValueOnce(new Response("unavailable", {status: 503}));

        await expect(agent.setProvider({...GATEWAY, baseUrl: "https://other.example/v1"})).rejects.toThrow();

        expect(fixture.getCodexAcpClient().listProviders()[0]?.current?.baseUrl).toBe(GATEWAY.baseUrl);
        expect((await fixture.getCodexAcpClient().fetchAvailableModels()).map(m => m.id)).toEqual(["gpt-5.4"]);
    });

    it("offers no model when the gateway lists none of the Codex models", async () => {
        fetchMock.mockResolvedValue(listing([]));
        const fixture = createFixture();
        await fixture.getCodexAcpAgent().setProvider(GATEWAY);

        expect(await fixture.getCodexAcpClient().fetchAvailableModels()).toEqual([]);
        const response = await openSession(fixture, "gpt-5.5");
        expect(response.configOptions?.find(o => o.id === MODEL_CONFIG_ID)).toBeUndefined();
        expect(fixture.getCodexAcpAgent().getSessionState(response.sessionId).currentModelId).toBe("gpt-5.5[high]");
    });

    it.each([400, 401, 403, 404, 405, 429])("sets a gateway that answers %s and narrows nothing", async (status) => {
        fetchMock.mockResolvedValue(new Response("no", {status}));
        const fixture = createFixture();

        await expect(fixture.getCodexAcpAgent().setProvider(GATEWAY)).resolves.toEqual({});

        expect(fixture.getCodexAcpClient().listProviders()[0]?.current?.baseUrl).toBe(GATEWAY.baseUrl);
        expect(await fixture.getCodexAcpClient().fetchAvailableModels()).toEqual(codexModels());
    });

    it("does not list models when providers/set was not used", async () => {
        const fixture = createFixture();

        const response = await openSession(fixture, "gpt-5.5");

        expect(fetchMock).not.toHaveBeenCalled();
        expect(modelOptionValues(response)).toEqual(["gpt-5.5", "gpt-5.4", "mini", "gpt-5.3-codex"]);
    });

    it("does not list models for the gateway auth method", async () => {
        const fixture = createFixture();

        await fixture.getCodexAcpAgent().authenticate({
            methodId: "gateway",
            _meta: {gateway: {baseUrl: "https://gateway.example/v1", headers: {Authorization: "Bearer secret"}}},
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(await fixture.getCodexAcpClient().fetchAvailableModels()).toEqual(codexModels());
    });

    it("stops narrowing after providers/disable", async () => {
        fetchMock.mockResolvedValue(listing(["gpt-5.4"]));
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();
        await agent.setProvider(GATEWAY);
        expect((await fixture.getCodexAcpClient().fetchAvailableModels()).map(m => m.id)).toEqual(["gpt-5.4"]);

        await agent.disableProvider({providerId: OPENAI_PROVIDER_ID});

        expect(await fixture.getCodexAcpClient().fetchAvailableModels()).toEqual(codexModels());
    });

    it("reuses the listing for the same configuration and lists again for another one", async () => {
        fetchMock.mockImplementation(async () => listing(["gpt-5.4"]));
        const fixture = createFixture();
        const agent = fixture.getCodexAcpAgent();

        await agent.setProvider(GATEWAY);
        await agent.setProvider({...GATEWAY, headers: {...GATEWAY.headers}});
        expect(fetchMock).toHaveBeenCalledOnce();

        await agent.setProvider({...GATEWAY, headers: {Authorization: "Bearer other"}});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives the listing to the app-server that a provider restart starts, without listing again", async () => {
        fetchMock.mockImplementation(async () => listing(["gpt-5.4"]));
        const replacement = createFixture().getCodexAcpClient();
        vi.spyOn(replacement, "initialize").mockResolvedValue();
        vi.spyOn(replacement, "resumeSession").mockResolvedValue({models: []} as never);
        const fixture = createFixture(codexModels(), vi.fn().mockResolvedValue(replacement));
        const agent = fixture.getCodexAcpAgent();
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});
        const sessions = (agent as unknown as {sessions: Map<string, ReturnType<typeof createTestSessionState>>}).sessions;
        sessions.set("thread-1", createTestSessionState({sessionId: "thread-1"}));

        await agent.setProvider(GATEWAY);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect((await replacement.fetchAvailableModels()).map(m => m.id)).toEqual(["gpt-5.4"]);
    });

    it("applies a providers/set to the app-server that a provider restart starts while it lists the models", async () => {
        const otherListed = deferred<Response>();
        fetchMock.mockImplementation(async (url: string) => url.startsWith("https://other.example")
            ? otherListed.promise
            : listing(["gpt-5.4"]));
        const firstInitialized = deferred<void>();
        const first = createFixture().getCodexAcpClient();
        vi.spyOn(first, "initialize").mockReturnValue(firstInitialized.promise);
        vi.spyOn(first, "resumeSession").mockResolvedValue({models: []} as never);
        const second = createFixture().getCodexAcpClient();
        vi.spyOn(second, "initialize").mockResolvedValue();
        vi.spyOn(second, "resumeSession").mockResolvedValue({models: []} as never);
        const restart = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const fixture = createFixture(codexModels(), restart);
        const agent = fixture.getCodexAcpAgent();
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});
        const sessions = (agent as unknown as {sessions: Map<string, ReturnType<typeof createTestSessionState>>}).sessions;
        sessions.set("thread-1", createTestSessionState({sessionId: "thread-1"}));

        const firstSet = agent.setProvider(GATEWAY);
        await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
        const otherSet = agent.setProvider({...GATEWAY, baseUrl: "https://other.example/v1"});
        // The first restart installs its app-server while the other gateway lists its models.
        firstInitialized.resolve();
        await firstSet;
        otherListed.resolve(listing(["gpt-5.3-codex"]));
        await otherSet;

        expect(restart).toHaveBeenCalledTimes(2);
        expect(agent.listProviders({}).providers[0]?.current?.baseUrl).toBe("https://other.example/v1");
        expect(second.listProviders()[0]?.current?.baseUrl).toBe("https://other.example/v1");
        expect((await second.fetchAvailableModels()).map(m => m.id)).toEqual(["gpt-5.3-codex"]);
    });

    it("narrows the models of an open session after providers/set and widens them after providers/disable", async () => {
        const replacements = [createFixture(), createFixture()].map(replacementFixture => {
            vi.spyOn(replacementFixture.getCodexAppServerClient(), "threadResume").mockResolvedValue({
                thread: {id: "thread-id"},
                model: "gpt-5.5",
                modelProvider: "custom-gateway",
                reasoningEffort: "high",
                serviceTier: null,
            } as never);
            const client = replacementFixture.getCodexAcpClient();
            vi.spyOn(client, "initialize").mockResolvedValue();
            return client;
        });
        const restart = vi.fn().mockResolvedValueOnce(replacements[0]).mockResolvedValueOnce(replacements[1]);
        fetchMock.mockResolvedValue(listing(["gpt-5.4", "gpt-5.4-mini"]));
        const fixture = createFixture(codexModels(), restart);
        const agent = fixture.getCodexAcpAgent();
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});
        const response = await openSession(fixture, "gpt-5.5");
        expect(modelOptionValues(response)).toEqual(["gpt-5.5", "gpt-5.4", "mini", "gpt-5.3-codex"]);
        const lastModelUpdate = () => {
            const updates = fixture.getAcpConnectionEvents([])
                .filter(event => event.method === "sessionUpdate")
                .map(event => (event.args[0] as acp.SessionNotification).update)
                .filter(update => update.sessionUpdate === "config_option_update");
            const option = updates.at(-1)?.configOptions.find(o => o.id === MODEL_CONFIG_ID);
            return {
                currentValue: option?.currentValue,
                values: (option as {options: Array<{value: string}>} | undefined)?.options.map(o => o.value),
            };
        };

        await agent.setProvider(GATEWAY);

        expect(agent.getSessionState(response.sessionId).currentModelId).toBe("gpt-5.4[medium]");
        expect(lastModelUpdate()).toEqual({currentValue: "gpt-5.4", values: ["gpt-5.4", "mini"]});

        await agent.disableProvider({providerId: OPENAI_PROVIDER_ID});

        expect(agent.getSessionState(response.sessionId).currentModelId).toBe("gpt-5.4[medium]");
        expect(lastModelUpdate()).toEqual({currentValue: "gpt-5.4", values: ["gpt-5.5", "gpt-5.4", "mini", "gpt-5.3-codex"]});
    });
});
