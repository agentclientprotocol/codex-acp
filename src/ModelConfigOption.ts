import type {SessionConfigOption} from "@agentclientprotocol/sdk";
import type {ReasoningEffort} from "./app-server";
import type {Model, ReasoningEffortOption} from "./app-server/v2";

export const MODEL_CONFIG_ID = "model";
export const REASONING_EFFORT_CONFIG_ID = "reasoning_effort";

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

export function findSupportedEffort(
    options: ReadonlyArray<ReasoningEffortOption>,
    effort: string | undefined,
): ReasoningEffort | undefined {
    if (!effort) return undefined;
    return options.find(o => o.reasoningEffort === effort)?.reasoningEffort;
}

export function createModelConfigOption(availableModels: Array<Model>, currentBaseModelId: string): SessionConfigOption {
    const options: Array<{ value: string; name: string; description: string | null }> = availableModels.map(model => ({
        value: model.id,
        name: model.displayName,
        description: model.description,
    }));
    if (!availableModels.some(model => model.id === currentBaseModelId)) {
        options.unshift({
            value: currentBaseModelId,
            name: currentBaseModelId,
            description: null,
        });
    }

    return {
        id: MODEL_CONFIG_ID,
        name: "Model",
        description: "Model Codex uses for the session",
        category: "model",
        type: "select",
        currentValue: currentBaseModelId,
        options,
    };
}

export function createReasoningEffortConfigOption(
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    currentEffort: string,
): SessionConfigOption {
    return {
        id: REASONING_EFFORT_CONFIG_ID,
        name: "Reasoning effort",
        description: "How much reasoning effort the model should use",
        category: "thought_level",
        type: "select",
        currentValue: currentEffort,
        options: supportedReasoningEfforts.map(option => ({
            value: option.reasoningEffort,
            name: capitalize(option.reasoningEffort),
            description: option.description,
        })),
    };
}
