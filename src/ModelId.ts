import type {ReasoningEffort, ServiceTier} from "./app-server";
import type {Model} from "./app-server/v2";

/**
 * ACP Model ID, combining the base model ID, reasoning effort level, and optional service tier.
 * @example
 * const id = ModelId.fromString("gpt-5.2[high]");
 * const fastId = ModelId.fromString("gpt-5.2[high]@fast");
 */
export class ModelId {
    private constructor(
        public readonly model: string,
        public readonly effort: string,
        public readonly serviceTier: ServiceTier | null = null
    ) {}

    static fromComponents(model: Model, effort: ReasoningEffort, serviceTier: ServiceTier | null = null): ModelId {
        return new ModelId(model.id, effort, serviceTier);
    }

    static create(modelId: string, effort: ReasoningEffort, serviceTier: ServiceTier | null = null): ModelId {
        return new ModelId(modelId, effort, serviceTier);
    }

    static fromString(modelId: string): ModelId {
        const bracketMatch = modelId.match(/^(?<model>[^\[]+)\[(?<effort>[^\]]+)](?:@(?<serviceTier>.+))?$/);
        const model = bracketMatch?.groups?.["model"];
        const effort = bracketMatch?.groups?.["effort"];
        const serviceTier = bracketMatch?.groups?.["serviceTier"] ?? null;

        if (!model || !effort) {
            throw new Error(`Unsupported format of modelId: ${modelId}. Expected: modelId[effort] or modelId[effort]@fast.`);
        }

        // The generated app-server ServiceTier type also includes "flex", but ACP model IDs
        // only expose Fast variants for now because model/list advertises Fast support.
        if (serviceTier !== null && serviceTier !== "fast") {
            throw new Error(`Unsupported service tier ${serviceTier} for modelId: ${modelId}.`);
        }

        return new ModelId(model, effort, serviceTier);
    }

    toString(): string {
        const suffix = this.serviceTier === null ? "" : `@${this.serviceTier}`;
        return `${this.model}[${this.effort}]${suffix}`;
    }
}
