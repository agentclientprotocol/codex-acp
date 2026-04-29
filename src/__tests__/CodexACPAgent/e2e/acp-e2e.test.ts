import {afterEach, expect, it} from "vitest";
import {AgentMode} from "../../../AgentMode";
import {
    createAuthenticatedFixture,
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

    it("returns model response", async () => {
        fixture = await createAuthenticatedFixture();
        const session = await fixture.createSession();
        await fixture.expectPromptText(session.sessionId, "Reply with exactly integration-ok and nothing else.", (text) => {
            expect(text.toLowerCase()).toContain("integration-ok");
        });
    });

    it("returns model response when authenticated via gateway", async () => {
        const apiKey = requireLiveApiKey();
        fixture = await createGatewayFixture("https://api.openai.com/v1", {Authorization: `Bearer ${apiKey}`});
        const session = await fixture.createSession();
        await fixture.expectPromptText(session.sessionId, "Reply with exactly integration-ok and nothing else.", (text) => {
            expect(text.toLowerCase()).toContain("integration-ok");
        });
    });

    it("uses the selected session model for subsequent prompts", async () => {
        fixture = await createAuthenticatedFixture();
        const session = await fixture.createSession();

        const models = session.models;
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
            sessionId: session.sessionId,
            modelId: selectedModelId,
        });
        await fixture.expectStatus(session.sessionId, {Model: selectedModelId});
    });

    it("changes session mode via setSessionMode and reflects it in /status", async () => {
        fixture = await createAuthenticatedFixture();
        const session = await fixture.createSession();

        const modes = session.modes;
        expect(modes?.currentModeId).toBe(AgentMode.DEFAULT_AGENT_MODE.id);
        expect(modes?.availableModes.map((mode) => mode.id)).toEqual(
            AgentMode.all().map((mode) => mode.id),
        );

        const targetMode = AgentMode.AgentFullAccess;
        await fixture.connection.setSessionMode({
            sessionId: session.sessionId,
            modeId: targetMode.id,
        });

        await fixture.expectStatus(session.sessionId, {
            Approval: targetMode.approvalPolicy,
            Sandbox: targetMode.sandboxMode,
        });
    });

    it("respects INITIAL_AGENT_MODE when seeding the initial session mode", async () => {
        const initialMode = AgentMode.ReadOnly;
        fixture = await createAuthenticatedFixture({
            INITIAL_AGENT_MODE: initialMode.id,
        });
        const session = await fixture.createSession();

        expect(session.modes?.currentModeId).toBe(initialMode.id);

        await fixture.expectStatus(session.sessionId, {
            Approval: initialMode.approvalPolicy,
            Sandbox: initialMode.sandboxMode,
        });
    });

    it("lists a user skill from the wrapped CODEX_HOME", async () => {
        fixture = await createAuthenticatedFixture();
        fixture.writeSkill({
            name: "integration-skill",
            description: "Integration skill",
            body: "This skill exists only for integration testing.",
        });
        const session = await fixture.createSession();
        await fixture.expectPromptText(session.sessionId, "/skills", (text) => {
            expect(text).toContain("Available skills:");
            expect(text).toContain("- integration-skill: Integration skill");
        });
    });
});
