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
    const headingText = `### ${heading}`;
    const start = markdown.indexOf(headingText);
    if (start < 0) return new Map();
    const nextHeading = markdown.indexOf("\n### ", start + headingText.length);
    const section = markdown.slice(start, nextHeading < 0 ? undefined : nextHeading);
    const result = new Map<string, TierPricing>();

    for (const line of section.split(/\r?\n/)) {
        if (!line.startsWith("|")) continue;
        const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
        if (cells.length < 9 || cells[0] === "Model" || cells[0]?.startsWith("---")) continue;

        const documentedModel = cells[0]?.replace(/\s+\([^)]*\)\s*$/, "");
        if (documentedModel === undefined) continue;
        const matchingModelIds = requestedModels.get(documentedModel);
        if (matchingModelIds === undefined) continue;

        const shortContext = parseTokenRates(cells[1], cells[2], cells[4]);
        if (shortContext === null) continue;
        const longContext = parseTokenRates(cells[5], cells[6], cells[8]);
        const pricing: TierPricing = {
            shortContext,
            ...(longContext === null ? {} : {longContext}),
        };
        for (const modelId of matchingModelIds) {
            result.set(modelId, pricing);
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
    if (value === undefined || value === "-") return null;
    const amount = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function pricingModelId(modelId: string): string {
    return modelId.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
}
