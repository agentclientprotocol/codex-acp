import type {SessionConfigOption} from "@agentclientprotocol/sdk";
import type {ServiceTier} from "./app-server";
import type {Model} from "./app-server/v2";

export const FAST_MODE_CONFIG_ID = "fast-mode";
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";

const FAST_MODE_DESCRIPTION = "1.5x speed, increased usage";

export function modelSupportsFast(model: Model | undefined): boolean {
    return model?.additionalSpeedTiers?.includes("fast") ?? false;
}

export function resolveFastServiceTier(fastModeEnabled: boolean, currentModelSupportsFast: boolean): ServiceTier | null {
    return fastModeEnabled && currentModelSupportsFast ? "fast" : null;
}

export function createFastModeConfigOption(fastModeEnabled: boolean): SessionConfigOption {
    return {
        id: FAST_MODE_CONFIG_ID,
        name: "Fast mode",
        description: FAST_MODE_DESCRIPTION,
        category: FAST_MODE_CONFIG_ID,
        type: "select",
        currentValue: fastModeEnabled ? FAST_MODE_ON : FAST_MODE_OFF,
        options: [
            {
                value: FAST_MODE_OFF,
                name: "Off",
                description: "Default speed, normal usage",
            },
            {
                value: FAST_MODE_ON,
                name: "On",
                description: FAST_MODE_DESCRIPTION,
            },
        ],
    };
}
