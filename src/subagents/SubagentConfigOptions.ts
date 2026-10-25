import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type {ReasoningEffort} from "../app-server";
import {createModelConfigOption, createReasoningEffortConfigOption} from "../ModelConfigOption";

/** Report only observed child values; none of these options grants configuration controls. */
export function subagentConfigOptions(configuration: {
    model: string | null;
    effort: ReasoningEffort | null;
}): SessionConfigOption[] {
    const options: SessionConfigOption[] = [];
    if (configuration.model) options.push(createModelConfigOption([], configuration.model));
    if (configuration.effort !== null) {
        options.push(createReasoningEffortConfigOption([{
            reasoningEffort: configuration.effort, description: "Current reasoning effort",
        }], configuration.effort));
    }
    return options;
}
