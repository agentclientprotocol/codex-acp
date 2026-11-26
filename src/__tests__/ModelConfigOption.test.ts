import {describe, expect, it} from "vitest";
import {createModelConfigOption, createReasoningEffortConfigOption, formatModelDisplayName} from "../ModelConfigOption";
import {createTestModel} from "./acp-test-utils";

describe("formatModelDisplayName", () => {
    it.each([
        ["gpt-6-astra", "6 Astra"],
        ["GPT-5.6-Sol", "5.6 Sol"],
        ["gpt-5.6-terra", "5.6 Terra"],
        ["gpt-5.6-luna", "5.6 Luna"],
        ["gpt-5.5", "5.5"],
        ["gpt-5.3-codex-spark", "5.3 Codex Spark"],
        ["gpt-5.3/codex-spark", "5.3 Codex Spark"],
        ["gpt-oss-120B", "Oss 120B"],
    ])("formats %s as %s", (displayName, expected) => {
        expect(formatModelDisplayName(displayName)).toBe(expected);
    });

    it.each(["Claude Opus", "custom-provider/model-v2", "o3-mini"])(
        "preserves non-GPT model name %s",
        (displayName) => {
            expect(formatModelDisplayName(displayName)).toBe(displayName);
        },
    );
});

describe("createModelConfigOption", () => {
    it("uses compact GPT labels without changing model ids", () => {
        const option = createModelConfigOption([
            createTestModel({id: "gpt-6-astra", displayName: "GPT-6-Astra"}),
            createTestModel({id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol"}),
            createTestModel({id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark"}),
        ], "gpt-5.6-sol");

        expect(option).toMatchObject({
            currentValue: "gpt-5.6-sol",
            options: [
                {value: "gpt-6-astra", name: "6 Astra"},
                {value: "gpt-5.6-sol", name: "5.6 Sol"},
                {value: "gpt-5.3-codex-spark", name: "5.3 Codex Spark"},
            ],
        });
    });

    describe("with per-model reasoning efforts", () => {
        const efforts = (...levels: string[]) => levels.map(reasoningEffort => ({reasoningEffort, description: reasoningEffort}));
        const models = [
            createTestModel({
                id: "ordered",
                supportedReasoningEfforts: efforts("xhigh", "low", "custom", "high"),
                defaultReasoningEffort: "high",
            }),
            createTestModel({id: "unlisted-default", supportedReasoningEfforts: efforts("low"), defaultReasoningEffort: "medium"}),
            createTestModel({id: "no-efforts", supportedReasoningEfforts: []}),
        ];

        it("lists the efforts of each model in the Codex order with the default as the recommendation", () => {
            const option = createModelConfigOption(models, "uncataloged", undefined, true);
            expect(option.type === "select" && option.options).toEqual([
                {value: "uncataloged", name: "uncataloged", description: null},
                {
                    value: "ordered", name: "ordered", description: "ordered model",
                    _meta: {jetbrains: {air: {version: 1, reasoningEfforts: {
                        values: ["xhigh", "low", "custom", "high"],
                        recommended: "high",
                    }}}},
                },
                {
                    value: "unlisted-default", name: "unlisted-default", description: "unlisted-default model",
                    _meta: {jetbrains: {air: {version: 1, reasoningEfforts: {values: ["low"]}}}},
                },
                {value: "no-efforts", name: "no-efforts", description: "no-efforts model"},
            ]);
        });

        it.each(["ordered", "unlisted-default"])("recommends the effort that the effort option of %s recommends", id => {
            const model = models.find(candidate => candidate.id === id)!;
            const modelOption = createModelConfigOption(models, id, undefined, true);
            const effortOption = createReasoningEffortConfigOption(
                model.supportedReasoningEfforts, model.defaultReasoningEffort, model.defaultReasoningEffort,
            );
            const entry = modelOption.type === "select"
                ? modelOption.options.find(option => "value" in option && option.value === id)
                : undefined;
            const air = (meta: unknown) => (meta as {jetbrains: {air: Record<string, any>}} | undefined)?.jetbrains.air;
            expect(air(entry?._meta)?.["reasoningEfforts"].recommended).toBe(air(effortOption._meta)?.["recommendedValue"]);
        });

        it("adds no entry metadata by default", () => {
            const option = createModelConfigOption(models, "ordered");
            expect(option.type === "select" && option.options.some(entry => "_meta" in entry)).toBe(false);
        });
    });
});

describe("createReasoningEffortConfigOption", () => {
    it("preserves the model's effort ordering, including advanced and provider-defined levels", () => {
        const levels = ["none", "minimal", "low", "medium", "custom-between", "high", "xhigh", "max", "ultra", "persistent"];
        const efforts = levels.map(reasoningEffort => ({reasoningEffort, description: reasoningEffort}));
        const option = createReasoningEffortConfigOption(efforts, "high");
        expect(option).toMatchObject({currentValue: "high", options: levels.map(value => ({value}))});
        expect(efforts.map(option => option.reasoningEffort)).toEqual(levels);
    });
});
