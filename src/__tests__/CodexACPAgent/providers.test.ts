import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture} from "../acp-test-utils";
import {CUSTOM_GATEWAY_PROVIDER_ID} from "../../CodexAcpClient";

function expectInvalidParams(fn: () => unknown): void {
    let caught: unknown;
    try {
        fn();
    } catch (err) {
        caught = err;
    }
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

    it("lists the custom gateway provider as unconfigured before any set", () => {
        const fixture = createCodexMockTestFixture();
        const response = fixture.getCodexAcpAgent().listProviders({});
        expect(response).toEqual({
            providers: [
                {
                    providerId: CUSTOM_GATEWAY_PROVIDER_ID,
                    supported: ["openai"],
                    required: false,
                    current: null,
                },
            ],
        });
    });

    it("reflects set routing in list without echoing headers", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        agent.setProvider({
            providerId: CUSTOM_GATEWAY_PROVIDER_ID,
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

    it("rejects an unsupported apiType with invalid_params", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        expectInvalidParams(() => agent.setProvider({
            providerId: CUSTOM_GATEWAY_PROVIDER_ID,
            apiType: "anthropic",
            baseUrl: "https://example.com",
        }));
    });

    it("rejects an unknown providerId with invalid_params", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        expectInvalidParams(() => agent.setProvider({
            providerId: "does-not-exist",
            apiType: "openai",
            baseUrl: "https://example.com",
        }));
    });

    it("rejects a malformed baseUrl with invalid_params", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        expectInvalidParams(() => agent.setProvider({
            providerId: CUSTOM_GATEWAY_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "   ",
        }));
    });

    it("disables the custom gateway provider and encodes it as current: null", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        agent.setProvider({
            providerId: CUSTOM_GATEWAY_PROVIDER_ID,
            apiType: "openai",
            baseUrl: "https://example.com",
        });
        expect(agent.listProviders({}).providers[0]!.current).not.toBeNull();

        agent.disableProvider({providerId: CUSTOM_GATEWAY_PROVIDER_ID});
        expect(agent.listProviders({}).providers[0]!.current).toBeNull();
    });

    it("treats disabling an unknown providerId as idempotent success", () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        expect(() => agent.disableProvider({providerId: "not-a-real-provider"})).not.toThrow();
        // The known provider remains discoverable.
        expect(agent.listProviders({}).providers[0]!.providerId).toBe(CUSTOM_GATEWAY_PROVIDER_ID);
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
            providerId: CUSTOM_GATEWAY_PROVIDER_ID,
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
