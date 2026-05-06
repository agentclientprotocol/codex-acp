import { describe, expect, it, vi } from "vitest";
import type { Model, ReasoningEffortOption } from "../../app-server/v2";
import { createCodexMockTestFixture } from "../acp-test-utils";

describe("Model filtering", () => {
    it("filters available models by id allowlist", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();

        const defaultEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Default effort."};
        const fastEffort: ReasoningEffortOption = {reasoningEffort: "low", description: "Fast effort."};
        const efforts: ReasoningEffortOption[] = [defaultEffort, fastEffort];

        const models: Model[] = [
            {
                id: "gpt-5.2",
                model: "gpt-5.2-model-field",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "GPT-5.2",
                description: "Allowed by id.",
                hidden: false,
                supportedReasoningEfforts: efforts,
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: ["fast"],
                isDefault: false,
                inputModalities: []
            },
            {
                id: "other-id",
                model: "gpt-5.2",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "gpt-5.2",
                description: "Allowed",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                isDefault: false,
                inputModalities: []
            },
            {
                id: "gpt-5.1-codex-mini",
                model: "other-model",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "Other",
                description: "Allowed by id.",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                isDefault: false,
                inputModalities: []
            },
            {
                id: "gpt-4o",
                model: "gpt-4o",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "gpt-4o",
                description: "Allowed.",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                isDefault: false,
                inputModalities: []
            },
        ];

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "gpt-5.2",
            currentReasoningEffort: "medium",
            currentServiceTier: null,
            models,
        });
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});

        const newSessionResponse = await codexAcpAgent.newSession({ cwd: "", mcpServers: [] });
        const sessionModels = newSessionResponse.models;
        const availableModels = sessionModels?.availableModels;

        expect(sessionModels?._meta).toEqual({
            currentReasoningEffort: "medium",
            currentServiceTier: null,
        });
        await expect(JSON.stringify(availableModels, null, 2)).toMatchFileSnapshot(
            "data/model-filtering.json"
        );
    });

    it("rejects fast model selections when the model does not support fast", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();

        const models: Model[] = [
            {
                id: "gpt-5.2",
                model: "gpt-5.2",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "GPT-5.2",
                description: "No fast tier.",
                hidden: false,
                supportedReasoningEfforts: [{reasoningEffort: "medium", description: "Default effort."}],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                isDefault: true,
                inputModalities: ["text"]
            },
        ];

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "gpt-5.2",
            currentReasoningEffort: "medium",
            currentServiceTier: null,
            models,
        });
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue(models);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});

        await codexAcpAgent.newSession({ cwd: "", mcpServers: [] });

        await expect(codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "gpt-5.2",
            _meta: { serviceTier: "fast" },
        })).rejects.toThrow("Unsupported service tier fast for model gpt-5.2");
    });

    it("stores fast model selections when the model supports fast", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();

        const models: Model[] = [
            {
                id: "gpt-5.2",
                model: "gpt-5.2",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                displayName: "GPT-5.2",
                description: "Fast tier.",
                hidden: false,
                supportedReasoningEfforts: [{reasoningEffort: "medium", description: "Default effort."}],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: ["fast"],
                isDefault: true,
                inputModalities: ["text"]
            },
        ];

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "gpt-5.2",
            currentReasoningEffort: "medium",
            currentServiceTier: null,
            models,
        });
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue(models);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});

        await codexAcpAgent.newSession({ cwd: "", mcpServers: [] });
        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "gpt-5.2",
            _meta: { serviceTier: "fast" },
        });

        expect(codexAcpAgent.getSessionState("session-id").currentModelId)
            .toBe("gpt-5.2");
        expect(codexAcpAgent.getSessionState("session-id").currentReasoningEffort)
            .toBe("medium");
        expect(codexAcpAgent.getSessionState("session-id").currentServiceTier)
            .toBe("fast");
    });

    it("uses the model default effort when _meta.reasoningEffort is omitted", async () => {
        const {codexAcpAgent} = await setupModelSelectionTest([createSelectableModel()]);

        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "gpt-5.2",
        });

        expect(codexAcpAgent.getSessionState("session-id").currentReasoningEffort).toBe("medium");
        expect(codexAcpAgent.getSessionState("session-id").currentServiceTier).toBeNull();
    });

    it("stores requested reasoning effort from _meta", async () => {
        const {codexAcpAgent} = await setupModelSelectionTest([createSelectableModel()]);

        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "gpt-5.2",
            _meta: { reasoningEffort: "low" },
        });

        expect(codexAcpAgent.getSessionState("session-id").currentModelId).toBe("gpt-5.2");
        expect(codexAcpAgent.getSessionState("session-id").currentReasoningEffort).toBe("low");
    });

    it("rejects unsupported reasoning effort selections", async () => {
        const {codexAcpAgent} = await setupModelSelectionTest([createSelectableModel()]);

        await expect(codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "gpt-5.2",
            _meta: { reasoningEffort: "xhigh" },
        })).rejects.toThrow("Unsupported reasoning effort xhigh for model gpt-5.2");
    });
});

function createSelectableModel(overrides: Partial<Model> = {}): Model {
    return {
        id: "gpt-5.2",
        model: "gpt-5.2",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "GPT-5.2",
        description: "Selectable model.",
        hidden: false,
        supportedReasoningEfforts: [
            {reasoningEffort: "low", description: "Fast effort."},
            {reasoningEffort: "medium", description: "Default effort."},
        ],
        defaultReasoningEffort: "medium",
        supportsPersonality: false,
        additionalSpeedTiers: ["fast"],
        isDefault: true,
        inputModalities: ["text"],
        ...overrides,
    };
}

async function setupModelSelectionTest(models: Model[]) {
    const initialModel = models[0];
    if (!initialModel) {
        throw new Error("setupModelSelectionTest requires at least one model");
    }
    const fixture = createCodexMockTestFixture();
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId: "session-id",
        currentModelId: initialModel.id,
        currentReasoningEffort: initialModel.defaultReasoningEffort,
        currentServiceTier: null,
        models,
    });
    vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue(models);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});

    await codexAcpAgent.newSession({ cwd: "", mcpServers: [] });
    return {fixture, codexAcpAgent, codexAcpClient};
}
