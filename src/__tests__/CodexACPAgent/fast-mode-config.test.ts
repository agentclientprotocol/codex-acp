import {describe, expect, it, vi} from "vitest";
import type {Model, ReasoningEffortOption} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_OFF,
    FAST_MODE_ON,
} from "../../FastModeConfig";

describe("Fast mode session config", () => {
    const defaultEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Balanced"};

    function createModel(id: string, additionalSpeedTiers: string[] = []): Model {
        return {
            id,
            model: id,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: id,
            description: `${id} model`,
            hidden: false,
            supportedReasoningEfforts: [defaultEffort],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            supportsPersonality: false,
            additionalSpeedTiers,
            isDefault: true,
        };
    }

    async function createSession(currentServiceTier: "fast" | "flex" | null = null) {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const fastModel = createModel("fast-model", ["fast"]);

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            models: [fastModel],
            currentServiceTier,
        });

        const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
        return {fixture, codexAcpAgent, codexAcpClient, response};
    }

    function setupPromptSession(fastModeEnabled: boolean, currentModelSupportsFast: boolean) {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            fastModeEnabled,
            currentModelSupportsFast,
            supportedReasoningEfforts: [defaultEffort],
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
        const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
            turn: {
                id: "turn-id",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            }
        });
        vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
            threadId: "session-id",
            turn: {
                id: "turn-id",
                items: [],
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            }
        });

        return {codexAcpAgent, turnStartSpy};
    }

    it("returns the Fast mode config option defaulted to Off for new sessions", async () => {
        const {response} = await createSession();

        expect(response.configOptions).toEqual([createFastModeConfigOption(false)]);
    });

    it("initializes Fast mode as On when the app-server session tier is fast", async () => {
        const {response, codexAcpAgent} = await createSession("fast");

        expect(response.configOptions).toEqual([createFastModeConfigOption(true)]);
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);
    });

    it("toggles Fast mode through session config options", async () => {
        const {codexAcpAgent} = await createSession();

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_ON,
        });
        expect(onResponse.configOptions).toEqual([createFastModeConfigOption(true)]);
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_OFF,
        });
        expect(offResponse.configOptions).toEqual([createFastModeConfigOption(false)]);
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

    it("keeps Fast mode selected across model switches but stops applying it for non-fast models", async () => {
        const {codexAcpAgent, codexAcpClient, fixture} = await createSession("fast");
        const slowModel = createModel("slow-model");
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([slowModel]);
        const turnStartSpy = vi.spyOn(fixture.getCodexAppServerClient(), "turnStart").mockResolvedValue({
            turn: {
                id: "turn-id",
                items: [],
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            }
        });
        vi.spyOn(fixture.getCodexAppServerClient(), "awaitTurnCompleted").mockResolvedValue({
            threadId: "session-id",
            turn: {
                id: "turn-id",
                items: [],
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            }
        });

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
