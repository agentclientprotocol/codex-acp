import type {ReasoningEffort} from "./app-server";
import type {Model} from "./app-server/v2";

/**
 * ACP Model ID, combining the base model ID and its reasoning effort level.
 * @example
 * const id = ModelId.fromString("gpt-5.2[high]");
 */
export class ModelId {
    private constructor(
        public readonly model: string,
        public readonly effort: string
    ) {}

    static fromComponents(model: Model, effort: ReasoningEffort): ModelId {
        return new ModelId(model.id, effort);
    }

    static create(modelId: string, effort: ReasoningEffort): ModelId {
        return new ModelId(modelId, effort);
    }

    static fromString(modelId: string): ModelId {
        const bracketMatch = modelId.match(/^(?<model>[^\[]+?)(?:\[(?<effort>[^\]]+)\])?$/);
        const model = bracketMatch?.groups?.["model"];
        const effort = bracketMatch?.groups?.["effort"];

        if (!model || !effort) {
            throw new Error(`Unsupported format of modelId: ${modelId}. Expected: modelId[effort].`);
        }

        if (model) {
            return new ModelId(model, effort);
        }

        throw new Error(`Invalid modelId format: ${modelId}`);
    }

    toString(): string {
        return `${this.model}[${this.effort}]`;
    }
}
