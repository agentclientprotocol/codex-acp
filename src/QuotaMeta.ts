import type {TokenCount} from "./TokenCount";

export interface ModelTokenCount {
    model: string;
    token_count: TokenCount;
}

export interface QuotaMeta {
    // Aggregated token count across all models
    token_count: TokenCount | null;

    // Token count for each model
    model_usage: ModelTokenCount[];
}
