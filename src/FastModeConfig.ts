import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {Model} from "./app-server/v2";

export const FAST_MODE_CONFIG_ID = "fast-mode";
export const FAST_MODE_CATEGORY = "model_config";
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";

export const ULTRAFAST_MODE = "ultrafast";
export type FastModeSelection = boolean | typeof ULTRAFAST_MODE;

const FAST_MODE_DESCRIPTION = "Faster responses, increased usage";

export function modelSupportsUltrafast(model: Model | undefined): boolean {
    return model?.serviceTiers?.some(tier => tier.id === ULTRAFAST_MODE)
        || (model?.additionalSpeedTiers?.includes(ULTRAFAST_MODE) ?? false);
}

export function fastModeFromServiceTier(tier: string | null | undefined): FastModeSelection {
    return tier === ULTRAFAST_MODE ? ULTRAFAST_MODE : tier === "fast" || tier === "priority";
}

export function normalizeFastMode(selection: FastModeSelection, model: Model | undefined): FastModeSelection {
    return selection === ULTRAFAST_MODE && !modelSupportsUltrafast(model) ? modelSupportsFast(model) : selection;
}

export function modelSupportsFast(model: Model | undefined): boolean {
    return model?.serviceTiers?.some(tier => tier.id === "fast" || tier.id === "priority")
        || (model?.additionalSpeedTiers?.includes("fast") ?? false);
}

export function resolveFastServiceTier(fastModeEnabled: FastModeSelection, currentModelSupportsFast: boolean): string | null {
    if (fastModeEnabled === ULTRAFAST_MODE) return ULTRAFAST_MODE;
    return fastModeEnabled && currentModelSupportsFast ? "fast" : null;
}

export function clientSupportsBooleanConfigOptions(clientCapabilities?: acp.ClientCapabilities | null): boolean {
    return clientCapabilities?.session?.configOptions?.boolean != null;
}

export function createFastModeConfigOption(fastModeEnabled: FastModeSelection, useBooleanConfigOption = false, model?: Model): SessionConfigOption {
    if (useBooleanConfigOption && !modelSupportsUltrafast(model)) {
        return {
            id: FAST_MODE_CONFIG_ID,
            name: "Fast mode",
            description: FAST_MODE_DESCRIPTION,
            category: FAST_MODE_CATEGORY,
            type: "boolean",
            currentValue: fastModeEnabled === true,
        };
    }

    return {
        id: FAST_MODE_CONFIG_ID,
        name: "Speed",
        description: "Service tier for the current model",
        category: FAST_MODE_CATEGORY,
        type: "select",
        currentValue: fastModeEnabled === ULTRAFAST_MODE ? ULTRAFAST_MODE : fastModeEnabled ? FAST_MODE_ON : FAST_MODE_OFF,
        options: [
            {
                value: FAST_MODE_OFF,
                name: "Standard",
                description: "Default speed, normal usage",
            },
            ...(model === undefined || modelSupportsFast(model) ? [{
                value: FAST_MODE_ON,
                name: "Fast",
                description: FAST_MODE_DESCRIPTION,
            }] : []),
            ...(modelSupportsUltrafast(model) ? [{
                value: ULTRAFAST_MODE,
                name: "Ultrafast",
                description: "Fastest responses, increased usage",
            }] : []),
        ],
    };
}
