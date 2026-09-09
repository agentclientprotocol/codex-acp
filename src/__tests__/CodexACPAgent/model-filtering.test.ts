import { describe, expect, it, vi } from "vitest";
import type { Model, ReasoningEffortOption } from "../../app-server/v2";
import { createCodexMockTestFixture, createTestModel } from "../acp-test-utils";

describe("Model filtering", () => {
    it("filters available models by id allowlist", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();

        const defaultEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Default effort."};
        const fastEffort: ReasoningEffortOption = {reasoningEffort: "low", description: "Fast effort."};
        const efforts: ReasoningEffortOption[] = [defaultEffort, fastEffort];

        const models: Model[] = [
            createTestModel({
                id: "gpt-6-astra",
                model: "gpt-6-astra",
                displayName: "gpt-6-astra",
                description: "Astra from the app-server model catalog.",
                supportedReasoningEfforts: (["low", "medium", "high", "xhigh", "max", "ultra"] as const).map(
                    reasoningEffort => ({reasoningEffort, description: `${reasoningEffort} effort.`}),
                ),
                defaultReasoningEffort: "low",
            }),
            {
                id: "gpt-5.2",
                model: "gpt-5.2-model-field",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                modelSpecialty: null,
                multiAgentVersion: null,
                displayName: "GPT-5.2",
                description: "Allowed by id.",
                hidden: false,
                supportedReasoningEfforts: efforts,
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
                inputModalities: []
            },
            {
                id: "other-id",
                model: "gpt-5.2",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                modelSpecialty: null,
                multiAgentVersion: null,
                displayName: "gpt-5.2",
                description: "Allowed",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
                inputModalities: []
            },
            {
                id: "gpt-5.1-codex-mini",
                model: "other-model",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                modelSpecialty: null,
                multiAgentVersion: null,
                displayName: "Other",
                description: "Allowed by id.",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
                inputModalities: []
            },
            {
                id: "gpt-4o",
                model: "gpt-4o",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                modelSpecialty: null,
                multiAgentVersion: null,
                displayName: "gpt-4o",
                description: "Allowed.",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
                inputModalities: []
            },
            {
                id: "gpt-5.3-codex",
                model: "gpt-5.3-codex",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                modelSpecialty: null,
                multiAgentVersion: null,
                displayName: "gpt-5.3-codex",
                description: "Codex suffix lowercased.",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
                inputModalities: []
            },
            {
                id: "gpt-5.4-mini",
                model: "gpt-5.4-mini",
                upgrade: null,
                upgradeInfo: null,
                availabilityNux: null,
                modelSpecialty: null,
                multiAgentVersion: null,
                displayName: "gpt-5.4-mini",
                description: "Mini suffix lowercased.",
                hidden: false,
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
                additionalSpeedTiers: [],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
                inputModalities: []
            },
        ];

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "gpt-5.2[medium]",
            models,
            collaborationMode: "default",
            additionalDirectories: [],
        });
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});

        const newSessionResponse = await codexAcpAgent.newSession({ cwd: "", mcpServers: [] });
        const sessionModels = newSessionResponse.models;
        const availableModels = sessionModels?.availableModels;

        await expect(JSON.stringify(availableModels, null, 2)).toMatchFileSnapshot(
            "data/model-filtering.json"
        );
    });
});
