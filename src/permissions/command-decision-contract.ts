import type {
    AdditionalPermissionProfile,
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    NetworkPolicyAmendment,
} from "../app-server/v2";
import {isRecord} from "./json";

export type CommandParamsWithAvailableDecisions = CommandExecutionRequestApprovalParams & {
    additionalPermissions?: AdditionalPermissionProfile | null;
    availableDecisions?: unknown;
};

export function parseAvailableCommandDecisions(
    params: CommandParamsWithAvailableDecisions,
): CommandExecutionApprovalDecision[] | undefined {
    if (params.availableDecisions === undefined || params.availableDecisions === null) {
        return defaultCommandDecisions(params);
    }
    if (!Array.isArray(params.availableDecisions) || params.availableDecisions.length === 0) return undefined;
    const decisions: CommandExecutionApprovalDecision[] = [];
    for (const candidate of params.availableDecisions) {
        const decision = parseCommandDecision(candidate, params);
        if (!decision) return undefined;
        decisions.push(decision);
    }
    return decisions;
}

function defaultCommandDecisions(
    params: CommandParamsWithAvailableDecisions,
): CommandExecutionApprovalDecision[] {
    if (params.networkApprovalContext) {
        const decisions: CommandExecutionApprovalDecision[] = ["accept", "acceptForSession"];
        for (const amendment of params.proposedNetworkPolicyAmendments ?? []) {
            decisions.push({applyNetworkPolicyAmendment: {network_policy_amendment: amendment}});
        }
        decisions.push("decline", "cancel");
        return decisions;
    }
    if (params.additionalPermissions) return ["accept", "cancel"];
    const decisions: CommandExecutionApprovalDecision[] = ["accept", "acceptForSession"];
    if (params.proposedExecpolicyAmendment && params.proposedExecpolicyAmendment.length > 0) {
        decisions.push({
            acceptWithExecpolicyAmendment: {execpolicy_amendment: params.proposedExecpolicyAmendment},
        });
    }
    decisions.push("decline", "cancel");
    return decisions;
}

function parseCommandDecision(
    candidate: unknown,
    params: CommandExecutionRequestApprovalParams,
): CommandExecutionApprovalDecision | undefined {
    if (candidate === "accept" || candidate === "acceptForSession" || candidate === "decline" || candidate === "cancel") {
        return candidate;
    }
    if (!isRecord(candidate)) return undefined;

    if ("acceptWithExecpolicyAmendment" in candidate) {
        const value = candidate["acceptWithExecpolicyAmendment"];
        if (!isRecord(value)) return undefined;
        const amendment = value["execpolicy_amendment"];
        if (!isStringArray(amendment) || amendment.length === 0) return undefined;
        if (!sameStrings(amendment, params.proposedExecpolicyAmendment)) return undefined;
        return {acceptWithExecpolicyAmendment: {execpolicy_amendment: [...amendment]}};
    }

    if ("applyNetworkPolicyAmendment" in candidate) {
        const value = candidate["applyNetworkPolicyAmendment"];
        if (!isRecord(value)) return undefined;
        const amendment = parseNetworkAmendment(value["network_policy_amendment"]);
        if (!amendment || !params.networkApprovalContext) return undefined;
        if (amendment.host !== params.networkApprovalContext.host) return undefined;
        if (!(params.proposedNetworkPolicyAmendments ?? []).some(proposed => sameNetworkAmendment(proposed, amendment))) {
            return undefined;
        }
        return {applyNetworkPolicyAmendment: {network_policy_amendment: amendment}};
    }
    return undefined;
}

function parseNetworkAmendment(value: unknown): NetworkPolicyAmendment | undefined {
    if (!isRecord(value) || typeof value["host"] !== "string") return undefined;
    const action = value["action"];
    if (action !== "allow" && action !== "deny") return undefined;
    return {host: value["host"], action};
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function sameStrings(left: readonly string[], right?: readonly string[] | null): boolean {
    return !!right && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNetworkAmendment(left: NetworkPolicyAmendment, right: NetworkPolicyAmendment): boolean {
    return left.host === right.host && left.action === right.action;
}
