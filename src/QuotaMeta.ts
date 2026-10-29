import type {TokenCount} from "./TokenCount";

export interface ModelTokenCount {
    model: string;
    token_count: TokenCount;
}

export interface QuotaMeta {
    // Token count of the root thread, the same counts as PromptResponse.usage
    token_count: TokenCount | null;

    // Token count for each model, including the subagents
    model_usage: ModelTokenCount[];
}
