import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    setupPromptTestSession,
} from "../acp-test-utils";
import {
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_OFF,
    FAST_MODE_ON,
} from "../../FastModeConfig";
import {MODEL_CONFIG_ID} from "../../ModelConfigOption";

describe("Fast mode session config", () => {
    const booleanConfigCapabilities: acp.ClientCapabilities = {
        session: {
            configOptions: {
                boolean: {},
            },
        },
    };

    async function createSession(
        currentServiceTier: "fast" | "flex" | null = null,
        clientInfo: acp.Implementation | null = null,
        clientCapabilities?: acp.ClientCapabilities,
    ) {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const fastModel = createTestModel({
            id: "fast-model",
            additionalSpeedTiers: ["fast"],
        });
        const slowModel = createTestModel({id: "slow-model"});

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            models: [fastModel, slowModel],
            currentServiceTier,
            additionalDirectories: [],
        });

        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo,
            ...(clientCapabilities ? {clientCapabilities} : {}),
        });

        const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
        return {fixture, codexAcpAgent, codexAcpClient, response};
    }

    function setupPromptSession(fastModeEnabled: boolean, currentModelSupportsFast: boolean) {
        const {mockFixture, turnStartSpy} = setupPromptTestSession({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            fastModeEnabled,
            currentModelSupportsFast,
        });
        return {codexAcpAgent: mockFixture.getCodexAcpAgent(), turnStartSpy};
    }

    it("returns the Fast mode config option defaulted to Off for new sessions", async () => {
        const {response} = await createSession();

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("returns the Fast mode config option as a boolean when the client supports it", async () => {
        const {response} = await createSession(null, null, booleanConfigCapabilities);

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false, true));
        const option = response.configOptions?.find(option => option.id === FAST_MODE_CONFIG_ID);
        expect(option).toMatchObject({
            id: FAST_MODE_CONFIG_ID,
            type: "boolean",
            currentValue: false,
        });
        expect(option).not.toHaveProperty("options");
    });

    it("keeps the Fast mode select option when boolean support is explicitly absent", async () => {
        const {response} = await createSession(null, null, {
            session: {
                configOptions: {
                    boolean: null,
                },
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("initializes Fast mode as On when the app-server session tier is fast", async () => {
        const {response, codexAcpAgent} = await createSession("fast");

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);
    });

    it("omits Fast mode config options for JetBrains 2026.1 IntelliJ clients", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.WebStorm",
            version: "2026.1.1",
            title: "WebStorm 2026.1.1",
            _meta: {
                platform: "intellij",
            },
        });

        expect(response.configOptions).toBeUndefined();
    });

    it("omits Fast mode config options for JetBrains 2026.1 clients by name", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.IDE",
            version: "2026.1",
            title: "JetBrains IDE",
        });

        expect(response.configOptions).toBeUndefined();
    });

    it("keeps Fast mode config options for JetBrains clients outside 2026.1", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.WebStorm",
            version: "2026.2.0",
            title: "WebStorm 2026.2.0",
            _meta: {
                platform: "intellij",
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("keeps Fast mode config options for non-JetBrains 2026.1 clients", async () => {
        const {response} = await createSession(null, {
            name: "VSCode",
            version: "2026.1.1",
            title: "VS Code",
            _meta: {
                platform: "vscode",
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("toggles Fast mode through session config options", async () => {
        const {codexAcpAgent} = await createSession();

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_ON,
        });
        expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_OFF,
        });
        expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);
    });

    it("toggles Fast mode through boolean session config options", async () => {
        const {codexAcpAgent} = await createSession(null, null, booleanConfigCapabilities);

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: true,
        });
        expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true, true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: false,
        });
        expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false, true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);
    });

    it("rejects unknown Fast mode config ids and values", async () => {
        const {codexAcpAgent} = await createSession();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: "unknown-config",
            value: FAST_MODE_ON,
        })).rejects.toThrow();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: "turbo",
        })).rejects.toThrow();
    });

    it("sends the fast service tier when Fast mode is enabled for a fast-capable model", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(true, true);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: "fast",
        }));
    });

    it("explicitly clears service tier when Fast mode is off", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(false, true);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: null,
        }));
    });

    it("explicitly clears service tier when the selected model does not support fast", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(true, false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: null,
        }));
    });

    it("removes the Fast mode config option when switching to a non-fast model via session_config", async () => {
        const {codexAcpAgent} = await createSession("fast");

        const fastResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "fast-model",
        });
        expect(fastResponse.configOptions?.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(true);

        const slowResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "slow-model",
        });
        expect(slowResponse.configOptions?.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(false);
    });

    it("keeps Fast mode selected across model switches but stops applying it for non-fast models", async () => {
        const {codexAcpAgent, codexAcpClient, fixture} = await createSession("fast");
        const slowModel = createTestModel({id: "slow-model"});
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([slowModel]);
        const turnStartSpy = mockPromptTurn(fixture, "session-id");

        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "slow-model[medium]",
        });

        const sessionState = codexAcpAgent.getSessionState("session-id");
        expect(sessionState.fastModeEnabled).toBe(true);
        expect(sessionState.currentModelSupportsFast).toBe(false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            model: "slow-model",
            serviceTier: null,
        }));
    });
});
