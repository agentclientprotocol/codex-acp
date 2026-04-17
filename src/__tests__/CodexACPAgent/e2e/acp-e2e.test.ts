import {afterEach, expect, it} from "vitest";
import {
    createAuthenticatedFixture,
    createFixtureWithSkill,
    describeE2E,
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
        await fixture.expectPromptText("Reply with exactly integration-ok and nothing else.", (text) => {
            expect(text.toLowerCase()).toContain("integration-ok");
        });
    });

    it('lists a user skill from the wrapped CODEX_HOME', async () => {
        fixture = await createFixtureWithSkill({
            name: "integration-skill",
            description: "Integration skill",
            body: "This skill exists only for integration testing.",
        });
        await fixture.expectPromptText("/skills", (text) => {
            expect(text).toContain("Available skills:");
            expect(text).toContain("- integration-skill: Integration skill");
        });
    });
});
