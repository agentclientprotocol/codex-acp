import {afterEach, expect, it} from "vitest";
import {
    createAuthenticatedFixture,
    createFixtureWithSkill,
    createGatewayFixture,
    describeE2E,
    requireLiveApiKey,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

describeE2E("E2E tests", () => {
    let fixture: SpawnedAgentFixture | null = null;

    afterEach(async () => {
        if (fixture) {
            await fixture.dispose();
            fixture = null;
        }
    });

    it('returns model response', async () => {
        fixture = await createAuthenticatedFixture();
        const session = await fixture.createSession();
        await session.expectPromptText("Reply with exactly integration-ok and nothing else.", (text) => {
            expect(text.toLowerCase()).toContain("integration-ok");
        });
    });

    it('returns model response when authenticated via gateway', async () => {
        const apiKey = requireLiveApiKey();
        fixture = await createGatewayFixture({
            baseUrl: "https://api.openai.com/v1",
            headers: {Authorization: `Bearer ${apiKey}`},
        });
        const session = await fixture.createSession();
        await session.expectPromptText("Reply with exactly integration-ok and nothing else.", (text) => {
            expect(text.toLowerCase()).toContain("integration-ok");
        });
    });

    it("uses the selected session model for subsequent prompts", async () => {
        fixture = await createAuthenticatedFixture();
        const session = await fixture.createSession();

        const models = session.response.models;
        if (!models) {
            throw new Error("Agent did not return initial model state.");
        }
        expect(models.availableModels.length).toBeGreaterThan(0);

        const selectedModelId =
            models.availableModels.find((model) => model.modelId !== models.currentModelId)?.modelId
            ?? models.currentModelId
            ?? models.availableModels[0]?.modelId;
        if (!selectedModelId) {
            throw new Error("No available models returned by ACP server.");
        }

        await fixture.connection.unstable_setSessionModel({
            sessionId: session.response.sessionId,
            modelId: selectedModelId,
        });
        await session.expectPromptText("/status", (text) => {
            expect(text).toContain(`**Model:** ${selectedModelId}`);
        });
    });

    it('lists a user skill from the wrapped CODEX_HOME', async () => {
        fixture = await createFixtureWithSkill({
            name: "integration-skill",
            description: "Integration skill",
            body: "This skill exists only for integration testing.",
        });
        const session = await fixture.createSession();
        await session.expectPromptText("/skills", (text) => {
            expect(text).toContain("Available skills:");
            expect(text).toContain("- integration-skill: Integration skill");
        });
    });
});
