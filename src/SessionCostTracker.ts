import type {Cost} from "@agentclientprotocol/sdk";
import type {TokenCount} from "./TokenCount";
import type {ModelPricingSnapshot, TierPricing, TokenRates} from "./PricingProvider";

const LONG_CONTEXT_THRESHOLD = 272_000;
const TOKENS_PER_MILLION = 1_000_000;

export class SessionCostTracker {
    private previousTotalUsage: TokenCount | null = null;
    private amountUsd = 0;
    private available: boolean;

    constructor(
        private readonly pricing: ModelPricingSnapshot,
        private baselineInitialUsage = false,
    ) {
        this.available = pricing.size > 0;
    }

    static disabled(): SessionCostTracker {
        return new SessionCostTracker(new Map());
    }

    update(
        totalUsage: TokenCount,
        lastUsage: TokenCount,
        currentModelId: string,
        fastModeEnabled: boolean,
    ): Cost | null {
        const delta = usageDelta(totalUsage, this.previousTotalUsage);
        this.previousTotalUsage = {...totalUsage};
        if (!this.available || delta === null) {
            this.available = false;
            return null;
        }

        const modelId = currentModelId.replace(/\[[^\]]*]$/, "");
        const modelPricing = this.pricing.get(modelId);
        const tierPricing = fastModeEnabled ? modelPricing?.fast : modelPricing?.standard;
        const rates = selectRates(tierPricing, lastUsage);
        if (rates === null) {
            this.available = false;
            return null;
        }

        if (this.baselineInitialUsage) {
            this.baselineInitialUsage = false;
            return {amount: this.amountUsd, currency: "USD"};
        }

        const incrementalCost = (
            delta.inputTokens * rates.input
            + delta.cachedInputTokens * rates.cachedInput
            + delta.outputTokens * rates.output
        ) / TOKENS_PER_MILLION;
        if (!Number.isFinite(incrementalCost) || incrementalCost < 0) {
            this.available = false;
            return null;
        }

        this.amountUsd += incrementalCost;
        return {amount: this.amountUsd, currency: "USD"};
    }
}

function selectRates(pricing: TierPricing | undefined, lastUsage: TokenCount): TokenRates | null {
    if (pricing === undefined) return null;
    const inputTokens = lastUsage.inputTokens + lastUsage.cachedInputTokens;
    if (inputTokens > LONG_CONTEXT_THRESHOLD) {
        return pricing.longContext ?? null;
    }
    return pricing.shortContext;
}

function usageDelta(current: TokenCount, previous: TokenCount | null): TokenCount | null {
    if (previous === null) return {...current};
    if (
        current.totalTokens < previous.totalTokens
        || current.inputTokens < previous.inputTokens
        || current.cachedInputTokens < previous.cachedInputTokens
        || current.outputTokens < previous.outputTokens
        || current.reasoningOutputTokens < previous.reasoningOutputTokens
    ) {
        return null;
    }
    return {
        totalTokens: current.totalTokens - previous.totalTokens,
        inputTokens: current.inputTokens - previous.inputTokens,
        cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
        outputTokens: current.outputTokens - previous.outputTokens,
        reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    };
}
