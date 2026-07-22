import {afterEach, beforeEach, expect, it} from "vitest";
import {createAuthenticatedFixture, describeE2E, type SpawnedAgentFixture,} from "./acp-e2e-test-utils";
import {ModelId} from "../../../ModelId";

describeE2E("Models availability", () => {
    let fixture: SpawnedAgentFixture;

    beforeEach(async () => {
        fixture = await createAuthenticatedFixture();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it(`current model is one of the available models`, async () => {
        const session = await fixture.createSession();
        const models = session.models;
        expect(models).toBeTruthy();

        // Assert the session's own current model is selectable from the
        // advertised catalog, rather than pinning a specific model id that the
        // backend can retire. Compare base model ids so the check is also
        // independent of reasoning-effort formatting.
        const currentBaseModel = ModelId.fromString(models!.currentModelId).model;
        const availableBaseModels = models!.availableModels.map(m => ModelId.fromString(m.modelId).model);

        expect(availableBaseModels).toContain(currentBaseModel);
    });
});
