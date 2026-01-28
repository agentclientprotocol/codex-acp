import { describe, expect, it, vi } from "vitest";
import type { Model, ReasoningEffortOption } from "../../app-server/v2";
import { AgentMode } from "../../AgentMode";
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
                displayName: "GPT-5.2",
                description: "Allowed by id.",
                supportedReasoningEfforts: efforts,
                defaultReasoningEffort: "medium",
                isDefault: false,
            },
            {
                id: "other-id",
                model: "gpt-5.2",
                displayName: "gpt-5.2",
                description: "Looks allowed but id is not.",
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                isDefault: false,
            },
            {
                id: "gpt-5.1-codex-mini",
                model: "other-model",
                displayName: "Other",
                description: "Allowed by id.",
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                isDefault: false,
            },
            {
                id: "gpt-4o",
                model: "gpt-4o",
                displayName: "gpt-4o",
                description: "Not allowed.",
                supportedReasoningEfforts: [defaultEffort],
                defaultReasoningEffort: "medium",
                isDefault: false,
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
