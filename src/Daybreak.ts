import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {CyberAccessProgram, Model} from "./app-server/v2";

export function daybreakAccessProgram(enabled: boolean | undefined, model: Model | undefined): CyberAccessProgram | undefined {
    if (enabled === undefined) return undefined;
    if (!enabled) return "standard";
    const program = availableDaybreakAccessProgram(model);
    if (program !== undefined) return program;
    throw RequestError.invalidRequest(undefined, "Daybreak is unavailable for the current model and account. Choose an eligible model or use /daybreak to disable it.");
}

export function availableDaybreakAccessProgram(model: Model | undefined): CyberAccessProgram | undefined {
    const programs = model?.availableAccessPrograms?.cyber ?? [];
    if (programs.includes("daybreakRed")) return "daybreakRed";
    if (programs.includes("daybreakBlue")) return "daybreakBlue";
    return undefined;
}
