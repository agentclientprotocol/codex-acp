import {afterEach, beforeEach, expect, it} from "vitest";
import {createAuthenticatedFixture, describeE2E, type SpawnedAgentFixture, DEFAULT_TEST_MODEL_ID, OTHER_TEST_MODEL_ID,} from "./acp-e2e-test-utils";

describeE2E("Models availability", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it(`default model is available`, async () => {
        const session = await fixture.createSession();
        const models = session.models?.availableModels?.map(m => m.modelId);
        expect(models).toContain(DEFAULT_TEST_MODEL_ID.toString());
        expect(models).toContain(OTHER_TEST_MODEL_ID.toString());
    });
});
