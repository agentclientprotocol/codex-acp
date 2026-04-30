import {describe, expect, it} from "vitest";
import {ModelId} from "../ModelId";

describe("ModelId", () => {
    it("formats and parses normal model IDs", () => {
        const modelId = ModelId.create("gpt-5.2", "medium");

        expect(modelId.toString()).toBe("gpt-5.2[medium]");
        expect(ModelId.fromString("gpt-5.2[medium]")).toEqual(modelId);
    });

    it("formats and parses fast model IDs", () => {
        const modelId = ModelId.create("gpt-5.2", "medium", "fast");

        expect(modelId.toString()).toBe("gpt-5.2[medium]@fast");
        expect(ModelId.fromString("gpt-5.2[medium]@fast")).toEqual(modelId);
    });

    it("rejects unknown service tiers", () => {
        expect(() => ModelId.fromString("gpt-5.2[medium]@flex"))
            .toThrow("Unsupported service tier flex");
    });
});
