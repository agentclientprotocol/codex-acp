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
                additionalSpeedTiers: [],
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
            currentModelId: "gpt-5.2[medium]",
            models,
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
