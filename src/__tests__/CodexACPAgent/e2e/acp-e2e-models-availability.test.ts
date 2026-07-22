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

    it(`default model is available`, async () => {
        const session = await fixture.createSession();
        const models = session.models;
        const availableModelIds = models?.availableModels?.map(m => m.modelId) ?? [];
        expect(availableModelIds.length).toBeGreaterThan(0);

        // Codex's advertised catalog changes as it is upgraded, so assert the
        // invariant that survives those bumps instead of pinning a specific
        // model id: the session's current (default) model must be one of the
        // advertised models. Compare on the base model id because
        // availableModels enumerate model x reasoning-effort pairs while the
        // current model may carry an effort (e.g. "none") that is not itself
        // enumerated.
        const currentModelId = models?.currentModelId;
        expect(currentModelId).toBeDefined();

        const currentBaseModel = ModelId.fromString(currentModelId!).model;
        const availableBaseModels = availableModelIds.map(id => ModelId.fromString(id).model);
        expect(availableBaseModels).toContain(currentBaseModel);
    });
});
