import type {ReasoningEffort} from "./app-server";
import type {Model, ThreadStartResponse} from "./app-server/v2";

export class ModelId {
    private constructor(
        public readonly model: string,
        public readonly effort: string | null // TODO: ThreadStartResponse
    ) {}

    static fromComponents(model: Model, effort: ReasoningEffort): ModelId {
        return new ModelId(model.id, effort);
    }

    static fromThreadResponse(response: ThreadStartResponse): ModelId {
        return new ModelId(response.model, response.reasoningEffort);
    }

    static fromString(modelId: string): ModelId {
        const parts = modelId.split("/");
        const model = parts[0];
        const effort = parts[1] ?? null;

        if (!model) {
            throw new Error(`Invalid modelId format: ${modelId}`);
        }
        return new ModelId(model, effort);
    }

    toString(): string {
        return this.effort ? `${this.model}/${this.effort}` : this.model;
    }
}