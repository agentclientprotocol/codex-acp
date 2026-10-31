import type {Model} from "./app-server/v2";
import {logger} from "./Logger";

export interface TokenRates {
    input: number;
    cachedInput: number;
    output: number;
}

export interface TierPricing {
    shortContext: TokenRates;
    longContext?: TokenRates;
}

export interface ModelPricing {
    standard: TierPricing;
    fast?: TierPricing;
}

export type ModelPricingSnapshot = ReadonlyMap<string, ModelPricing>;

export interface PricingProvider {
    getPricing(models: readonly Model[]): Promise<ModelPricingSnapshot>;
}

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const PRICING_FETCH_TIMEOUT_MS = 5_000;

export class OpenAiPricingProvider implements PricingProvider {
    private pricingDocument: Promise<string> | null = null;

    async getPricing(models: readonly Model[]): Promise<ModelPricingSnapshot> {
        if (models.length === 0) return new Map();

        try {
            const markdown = await this.getPricingDocument();
            return parseModelPricing(markdown, models.map(model => model.id));
        } catch (error) {
            logger.error("Failed to load OpenAI model pricing", error);
            return new Map();
        }
    }

    private async getPricingDocument(): Promise<string> {
        if (this.pricingDocument === null) {
            this.pricingDocument = this.fetchPricingDocument().catch(error => {
                this.pricingDocument = null;
                throw error;
            });
        }
        return await this.pricingDocument;
    }

    private async fetchPricingDocument(): Promise<string> {
        const response = await fetch(OPENAI_PRICING_URL, {
            headers: {accept: "text/markdown"},
            signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`OpenAI pricing request failed with HTTP ${response.status}`);
        }
        return await response.text();
    }
}

function parseModelPricing(markdown: string, modelIds: readonly string[]): ModelPricingSnapshot {
    const requestedModels = new Map<string, string[]>();
    for (const modelId of modelIds) {
        const pricingId = pricingModelId(modelId);
        const matchingIds = requestedModels.get(pricingId) ?? [];
        matchingIds.push(modelId);
        requestedModels.set(pricingId, matchingIds);
    }

    const standard = parsePricingSection(markdown, "Standard pricing data", requestedModels);
    const fast = parsePricingSection(markdown, "Fast pricing data", requestedModels);
    const result = new Map<string, ModelPricing>();
    for (const [modelId, standardPricing] of standard) {
        const fastPricing = fast.get(modelId);
        result.set(modelId, {
            standard: standardPricing,
            ...(fastPricing === undefined ? {} : {fast: fastPricing}),
        });
    }
    return result;
}

function parsePricingSection(
    markdown: string,
    heading: string,
    requestedModels: ReadonlyMap<string, readonly string[]>,
): Map<string, TierPricing> {
    const result = new Map<string, TierPricing>();
    const ambiguous = new Set<string>();
    let inSection = false;
    let headers: string[] | null = null;

    for (const line of markdown.split(/\r?\n/)) {
        if (line.startsWith("### ")) {
            inSection = line.trim() === `### ${heading}`;
            headers = null;
            continue;
        }
        if (!inSection || !line.startsWith("|")) continue;
        const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
        if (cells[0]?.toLowerCase() === "model") {
            headers = cells.map(cell => cell.toLowerCase().replace(/\s+/g, " "));
            continue;
        }
        if (headers === null || cells.length !== headers.length || cells[0]?.startsWith("---")) continue;
        const column = (name: string): string | undefined => {
            const index = headers!.indexOf(name);
            return index < 0 || headers!.lastIndexOf(name) !== index ? undefined : cells[index];
        };
        const documentedModel = cells[0]?.replace(/\s+\([^)]*\)\s*$/, "");
        if (documentedModel === undefined) continue;
        const matchingModelIds = requestedModels.get(documentedModel);
        if (matchingModelIds === undefined) continue;

        // Column positions changed when output moved and cache-write durations were added.
        // Unknown or ambiguous headers must never produce a plausible but incorrect price.
        const shortContext = parseTokenRates(
            column("short context input"), column("short context cached input"), column("short context output"),
        );
        if (shortContext === null) continue;
        const longContext = parseTokenRates(
            column("long context input"), column("long context cached input"), column("long context output"),
        );
        const pricing: TierPricing = {
            shortContext,
            ...(longContext === null ? {} : {longContext}),
        };
        for (const modelId of matchingModelIds) {
            if (ambiguous.has(modelId)) continue;
            const existing = result.get(modelId);
            if (existing && JSON.stringify(existing) !== JSON.stringify(pricing)) {
                result.delete(modelId);
                ambiguous.add(modelId);
            } else {
                result.set(modelId, pricing);
            }
        }
    }
    return result;
}

function parseTokenRates(
    inputValue: string | undefined,
    cachedInputValue: string | undefined,
    outputValue: string | undefined,
): TokenRates | null {
    const input = parseUsdRate(inputValue);
    const cachedInput = parseUsdRate(cachedInputValue);
    const output = parseUsdRate(outputValue);
    if (input === null || cachedInput === null || output === null) return null;
    return {input, cachedInput, output};
}

function parseUsdRate(value: string | undefined): number | null {
    if (value === undefined || !/^\$?(?:\d[\d,]*)(?:\.\d+)?$/.test(value)) return null;
    const amount = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function pricingModelId(modelId: string): string {
    return modelId.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
}
