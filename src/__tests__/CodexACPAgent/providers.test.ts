import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {CodexAcpClient, CUSTOM_GATEWAY_PROVIDER_ID, OPENAI_PROVIDER_ID} from "../../CodexAcpClient";

async function expectInvalidParams(fn: () => unknown): Promise<void> {
    const caught = await Promise.resolve().then(fn).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(acp.RequestError);
    expect((caught as acp.RequestError).code).toBe(-32602);
}

describe("Configurable LLM providers (providers/*)", () => {
    it("advertises the providers capability in initialize", async () => {
        const fixture = createCodexMockTestFixture();
        const result = await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
        });
        expect(result.agentCapabilities?.providers).toEqual({});
    });

    it("lists native OpenAI routing before any override", () => {
        const fixture = createCodexMockTestFixture();
        const response = fixture.getCodexAcpAgent().listProviders({});
        expect(response).toEqual({
            providers: [
                {
                    providerId: OPENAI_PROVIDER_ID,
                    supported: ["openai"],
                    required: false,
                    current: {
                        apiType: "openai",
                        baseUrl: "https://api.openai.com/v1",
                    },
                },
            ],
        });
    });

    it("restores the startup-configured proxy after the last override is disabled", () => {
        const fixture = createCodexMockTestFixture();
        const client = new CodexAcpClient(fixture.getCodexAppServerClient(), {
            model_provider: "company-proxy",
            model_providers: {
                "company-proxy": {base_url: "https://proxy.example/openai/v1"},
            },
        });
        client.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://temporary.example/openai/v1",
        });

        client.disableProvider({providerId: OPENAI_PROVIDER_ID});

        expect(client.listProviders()[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://proxy.example/openai/v1",
        });
    });

    it("reflects set routing in list without echoing headers", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
            headers: {Authorization: "Bearer super-secret"},
        });

        const provider = agent.listProviders({}).providers[0]!;
        expect(provider.current).toEqual({
            apiType: "openai",
            baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
        });
        // The secret headers must never be echoed back through providers/list.
        expect(JSON.stringify(provider)).not.toContain("super-secret");
    });

    it("rejects an unsupported apiType with invalid_params", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        await expectInvalidParams(() => agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "anthropic",
            baseUrl: "https://example.com",
        }));
    });

    it("rejects an unknown providerId with invalid_params", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        await expectInvalidParams(() => agent.setProvider({
            providerId: "does-not-exist",
            apiType: "openai",
            baseUrl: "https://example.com",
        }));
    });

    it("rejects a malformed baseUrl with invalid_params", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        await expectInvalidParams(() => agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "   ",
        }));
    });

    it("restores native OpenAI routing after disable", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://example.com",
        });
        expect(agent.listProviders({}).providers[0]!.current).not.toBeNull();

        agent.disableProvider({providerId: OPENAI_PROVIDER_ID});
        expect(agent.listProviders({}).providers[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://api.openai.com/v1",
        });
    });

    it("treats disabling an unknown providerId as idempotent success", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        expect(() => agent.disableProvider({providerId: "not-a-real-provider"})).not.toThrow();
        // The known provider remains discoverable.
        expect(agent.listProviders({}).providers[0]!.providerId).toBe(OPENAI_PROVIDER_ID);
    });

    it("applies the configured gateway to Codex config on session creation", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart")
            .mockRejectedValue(new Error("stop after capturing config"));

        agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://llm-gateway.corp.example.com/openai/v1",
            headers: {Authorization: "Bearer super-secret"},
        });

        await expect(agent.newSession({cwd: "/workspace", mcpServers: []})).rejects.toThrow();

        expect(threadStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            modelProvider: CUSTOM_GATEWAY_PROVIDER_ID,
            config: expect.objectContaining({
                model_providers: expect.objectContaining({
                    [CUSTOM_GATEWAY_PROVIDER_ID]: expect.objectContaining({
                        base_url: "https://llm-gateway.corp.example.com/openai/v1",
                        wire_api: "responses",
                        http_headers: expect.objectContaining({
                            "Authorization": "Bearer super-secret",
                            "X-Client-Feature-ID": "codex",
                        }),
                    }),
                }),
            }),
        }));
    });

    it("keeps native session creation unchanged when the providers API is unused", async () => {
        const restart = vi.fn();
        const fixture = createCodexMockTestFixture(restart);
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const threadStartSpy = vi.spyOn(codexAppServerClient, "threadStart")
            .mockRejectedValue(new Error("stop after capturing config"));

        await expect(agent.newSession({cwd: "/workspace", mcpServers: []})).rejects.toThrow();

        expect(restart).not.toHaveBeenCalled();
        expect(threadStartSpy).toHaveBeenCalledOnce();
        expect(threadStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            modelProvider: null,
            config: expect.not.objectContaining({
                model_providers: expect.objectContaining({
                    [CUSTOM_GATEWAY_PROVIDER_ID]: expect.anything(),
                }),
            }),
        }));
    });

    it("restarts app-server and resumes all loaded sessions through the full provider lifecycle", async () => {
        const firstGatewayReplacement = createCodexMockTestFixture().getCodexAcpClient();
        const secondGatewayReplacement = createCodexMockTestFixture().getCodexAcpClient();
        const nativeReplacement = createCodexMockTestFixture().getCodexAcpClient();
        vi.spyOn(firstGatewayReplacement, "initialize").mockResolvedValue();
        const firstGatewayResume = vi.spyOn(firstGatewayReplacement, "resumeSession").mockResolvedValue({} as never);
        vi.spyOn(secondGatewayReplacement, "initialize").mockResolvedValue();
        const secondGatewayResume = vi.spyOn(secondGatewayReplacement, "resumeSession").mockResolvedValue({} as never);
        vi.spyOn(nativeReplacement, "initialize").mockResolvedValue();
        const nativeResume = vi.spyOn(nativeReplacement, "resumeSession").mockResolvedValue({} as never);
        const restart = vi.fn()
            .mockResolvedValueOnce(firstGatewayReplacement)
            .mockResolvedValueOnce(secondGatewayReplacement)
            .mockResolvedValueOnce(nativeReplacement);
        const fixture = createCodexMockTestFixture(restart);
        const agent = fixture.getCodexAcpAgent();
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});
        const sessions = (agent as unknown as {sessions: Map<string, ReturnType<typeof createTestSessionState>>}).sessions;
        sessions.set("thread-1", createTestSessionState({sessionId: "thread-1", cwd: "/one"}));
        sessions.set("thread-2", createTestSessionState({sessionId: "thread-2", cwd: "/two"}));

        await agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://gateway.example/v1",
            headers: {Authorization: "Bearer secret"},
        });

        expect(restart).toHaveBeenCalledTimes(1);
        expect(firstGatewayReplacement.getModelProvider()).toBe(CUSTOM_GATEWAY_PROVIDER_ID);
        expect(firstGatewayResume).toHaveBeenCalledTimes(2);
        expect(firstGatewayResume).toHaveBeenCalledWith(expect.objectContaining({sessionId: "thread-1", cwd: "/one"}));
        expect(firstGatewayResume).toHaveBeenCalledWith(expect.objectContaining({sessionId: "thread-2", cwd: "/two"}));

        await agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://second-gateway.example/v1",
            headers: {Authorization: "Bearer replacement"},
        });

        expect(restart).toHaveBeenCalledTimes(2);
        expect(secondGatewayReplacement.getModelProvider()).toBe(CUSTOM_GATEWAY_PROVIDER_ID);
        expect(secondGatewayResume).toHaveBeenCalledTimes(2);
        expect(agent.listProviders({}).providers[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://second-gateway.example/v1",
        });

        await agent.disableProvider({providerId: OPENAI_PROVIDER_ID});

        expect(restart).toHaveBeenCalledTimes(3);
        expect(nativeReplacement.getModelProvider()).toBeNull();
        expect(nativeResume).toHaveBeenCalledTimes(2);
        expect(agent.listProviders({}).providers[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://api.openai.com/v1",
        });
    });

    it("attempts every session resume and allows a later provider update after one fails", async () => {
        const failedReplacement = createCodexMockTestFixture().getCodexAcpClient();
        const recoveredReplacement = createCodexMockTestFixture().getCodexAcpClient();
        vi.spyOn(failedReplacement, "initialize").mockResolvedValue();
        const failedResume = vi.spyOn(failedReplacement, "resumeSession")
            .mockRejectedValueOnce(new Error("thread-1 failed"))
            .mockResolvedValue({} as never);
        vi.spyOn(recoveredReplacement, "initialize").mockResolvedValue();
        const recoveredResume = vi.spyOn(recoveredReplacement, "resumeSession").mockResolvedValue({} as never);
        const restart = vi.fn()
            .mockResolvedValueOnce(failedReplacement)
            .mockResolvedValueOnce(recoveredReplacement);
        const fixture = createCodexMockTestFixture(restart);
        const agent = fixture.getCodexAcpAgent();
        await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});
        const sessions = (agent as unknown as {sessions: Map<string, ReturnType<typeof createTestSessionState>>}).sessions;
        sessions.set("thread-1", createTestSessionState({sessionId: "thread-1", cwd: "/one"}));
        sessions.set("thread-2", createTestSessionState({sessionId: "thread-2", cwd: "/two"}));

        await expect(agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://broken-gateway.example/v1",
        })).rejects.toThrow("Failed to resume 1 session(s)");

        expect(failedResume).toHaveBeenCalledTimes(2);

        await expect(agent.setProvider({
            providerId: OPENAI_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://recovered-gateway.example/v1",
        })).resolves.toEqual({});

        expect(restart).toHaveBeenCalledTimes(2);
        expect(recoveredResume).toHaveBeenCalledTimes(2);
        expect(agent.listProviders({}).providers[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://recovered-gateway.example/v1",
        });
    });

    it("shares state with the legacy gateway auth method", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpClient = fixture.getCodexAcpClient();

        await codexAcpClient.authenticate({
            methodId: "gateway",
            _meta: {
                gateway: {
                    baseUrl: "https://gateway.internal/openai",
                    headers: {Authorization: "Bearer via-auth"},
                    providerName: "Corp gateway",
                },
            },
        } as acp.AuthenticateRequest);

        expect(codexAcpClient.listProviders()[0]!.current).toEqual({
            apiType: "openai",
            baseUrl: "https://gateway.internal/openai",
        });
    });
});
