import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type {ReasoningEffort} from "./app-server";
import type {Model, ReasoningEffortOption} from "./app-server/v2";
import {AIR_RECOMMENDED_CONFIG_VALUE_KEY, withAirMeta} from "./AirExtension";

export const MODEL_CONFIG_ID = "model";
export const REASONING_EFFORT_CONFIG_ID = "reasoning_effort";

/**
 * Turn Codex's GPT display ids into compact picker labels without coupling the
 * adapter to a particular model catalog. Custom/provider model names remain
 * untouched because their punctuation may be meaningful.
 */
export function formatModelDisplayName(displayName: string): string {
    if (!/^gpt-/i.test(displayName)) return displayName;
    return displayName
        .replace(/^gpt-/i, "")
        .split(/[-/]+/)
        .filter(Boolean)
        .map(capitalize)
        .join(" ");
}

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

type ModelOption = { value: string; name: string; description: string | null };

/** The entries of the session `model` option. */
function modelOptions(availableModels: ReadonlyArray<Model>, currentBaseModelId: string | null): Array<ModelOption> {
    const options: Array<ModelOption> = availableModels.map(model => ({
        value: model.id,
        name: formatModelDisplayName(model.displayName),
        description: model.description,
    }));
    if (currentBaseModelId !== null && !availableModels.some(model => model.id === currentBaseModelId)) {
        options.unshift({
            value: currentBaseModelId,
            name: formatModelDisplayName(currentBaseModelId),
            description: null,
        });
    }
    return options;
}

export function createModelConfigOption(
    availableModels: Array<Model>,
    currentBaseModelId: string,
    recommendedModelId?: string,
): SessionConfigOption {
    const options = modelOptions(availableModels, currentBaseModelId);

    const recommendation = recommendedModelId && options.some(option => option.value === recommendedModelId)
        ? recommendedModelId
        : undefined;
    return {
        id: MODEL_CONFIG_ID,
        name: "Model",
        description: "Model Codex uses for the session",
        category: "model",
        type: "select",
        currentValue: currentBaseModelId,
        options,
        ...(recommendation
            ? {_meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_KEY, recommendation)}
            : {}),
    };
}

export function createReasoningEffortConfigOption(
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    currentEffort: string,
    recommendedEffort?: string,
): SessionConfigOption {
    const recommendation = findSupportedEffort(supportedReasoningEfforts, recommendedEffort);
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
        ...(recommendation
            ? {_meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_KEY, recommendation)}
            : {}),
    };
}

/**
 * The model option of a native subagent session. The client may not change the model of a subagent, so the
 * option offers only the current model. Its value and name are those of the same model in the `model` option
 * of the parent session, so that the client can compare them. A model that the parent option does not offer
 * keeps its full id as the value and the name.
 */
export function createSubagentModelConfigOption(
    availableModels: ReadonlyArray<Model>,
    parentBaseModelId: string | null,
    model: string,
): SessionConfigOption {
    // Without models the parent session has no model option, so there is nothing to match.
    const parentOptions = availableModels.length > 0 ? modelOptions(availableModels, parentBaseModelId) : [];
    // Codex can name a model by its `model` slug instead of its id.
    const id = availableModels.find(candidate => candidate.id === model)?.id
        ?? availableModels.find(candidate => candidate.model === model)?.id
        ?? model;
    const option = parentOptions.find(candidate => candidate.value === id)
        ?? {value: model, name: model, description: null};
    return {
        id: MODEL_CONFIG_ID,
        name: "Model",
        description: "Model Codex uses for the subagent",
        category: "model",
        type: "select",
        currentValue: option.value,
        options: [option],
    };
}
