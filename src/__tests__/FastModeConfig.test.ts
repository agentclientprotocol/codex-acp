import {describe, expect, it} from "vitest";
import {createTestModel} from "./acp-test-utils";
import {createFastModeConfigOption, fastModeFromServiceTier, modelSupportsFast, modelSupportsUltrafast, normalizeFastMode} from "../FastModeConfig";

describe("advertised speed tiers", () => {
    it.each(["fast", "priority"])("recognizes the %s Fast alias", tier => {
        const model = createTestModel({serviceTiers: [{id: tier, name: "Fast", description: ""}]});
        expect(modelSupportsFast(model)).toBe(true);
        expect(fastModeFromServiceTier(tier)).toBe(true);
    });

    it("uses catalog capabilities rather than model names", () => {
        const model = createTestModel({id: "custom-model", serviceTiers: [{id: "ultrafast", name: "Ultrafast", description: ""}]});
        expect(modelSupportsUltrafast(model)).toBe(true);
        expect(createFastModeConfigOption("ultrafast", true, model)).toMatchObject({type: "select", currentValue: "ultrafast"});
        expect(modelSupportsUltrafast(createTestModel({id: "gpt-6-astra"}))).toBe(false);
    });

    it("falls back to Standard when neither accelerated tier is available", () => {
        expect(normalizeFastMode("ultrafast", createTestModel())).toBe(false);
    });
});
