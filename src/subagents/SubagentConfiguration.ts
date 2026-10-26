import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type {ReasoningEffort} from "../app-server";
import {createReasoningEffortConfigOption, createSubagentModelConfigOption} from "../ModelConfigOption";
import type {SubagentModels} from "./CodexSubagentEventRouter";

export type ObservedSubagentConfiguration = {model: string | null; effort: ReasoningEffort | null};

/** Complete reported snapshots contain only observed child values and singleton choices. */
export function subagentConfigurationOptions(
    models: SubagentModels | null, configuration: ObservedSubagentConfiguration,
): SessionConfigOption[] {
    if (!models) return [];
    const options: SessionConfigOption[] = [];
    if (configuration.model) {
        options.push(createSubagentModelConfigOption(models.availableModels, models.currentModel, configuration.model));
    }
    if (configuration.effort !== null) {
        const model = models.availableModels.find(model => model.id === configuration.model || model.model === configuration.model);
        const effort = model?.supportedReasoningEfforts.find(option => option.reasoningEffort === configuration.effort)
            ?? {reasoningEffort: configuration.effort, description: "Current reasoning effort"};
        options.push(createReasoningEffortConfigOption([effort], configuration.effort));
    }
    return options;
}
