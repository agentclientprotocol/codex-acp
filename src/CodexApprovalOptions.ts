import type * as acp from "@agentclientprotocol/sdk";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    FileChangeApprovalDecision,
    NetworkPolicyAmendment,
} from "./app-server/v2";
import {ApprovalOptionId} from "./ApprovalOptionId";
import {optionPermissionMeta} from "./CodexPermissionMetadata";

export type DecisionOption<T> = {
    option: acp.PermissionOption;
    decision: T;
};

export type CommandParamsWithAvailableDecisions = CommandExecutionRequestApprovalParams & {
    availableDecisions?: unknown;
};

export function commandDecisionOptions(
    params: CommandParamsWithAvailableDecisions,
): DecisionOption<CommandExecutionApprovalDecision>[] | undefined {
    const decisions = parseAvailableCommandDecisions(params);
    if (!decisions) return undefined;

    const options: DecisionOption<CommandExecutionApprovalDecision>[] = [];
    let networkIndex = 0;
    for (const decision of decisions) {
        if (decision === "cancel") continue;
        if (decision === "accept") {
            options.push(decisionOption(ApprovalOptionId.AllowOnce, "Allow once", "allow_once", decision));
            continue;
        }
        if (decision === "acceptForSession") {
            options.push(decisionOption(
                ApprovalOptionId.AllowAlways,
                "Allow for session",
                "allow_always",
                decision,
                "Remember this approval until the Codex session ends",
            ));
            continue;
        }
        if (decision === "decline") {
            options.push(decisionOption(ApprovalOptionId.RejectOnce, "Reject", "reject_once", decision));
            continue;
        }
        if ("acceptWithExecpolicyAmendment" in decision) {
            options.push(decisionOption(
                ApprovalOptionId.AcceptWithExecpolicyAmendment,
                "Allow command pattern",
                "allow_always",
                decision,
                "Add the proposed command-prefix rule to persistent Codex policy",
            ));
            continue;
        }
        options.push(decisionOption(
            `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:${networkIndex++}`,
            decision.applyNetworkPolicyAmendment.network_policy_amendment.action === "allow"
                ? "Allow in future"
                : "Block in future",
            decision.applyNetworkPolicyAmendment.network_policy_amendment.action === "allow"
                ? "allow_always"
                : "reject_always",
            decision,
            decision.applyNetworkPolicyAmendment.network_policy_amendment.action === "allow"
                ? "Add the proposed allow rule to persistent Codex network policy"
                : "Add the proposed block rule to persistent Codex network policy",
        ));
    }

    const hasAllow = options.some(({option}) => option.kind === "allow_once" || option.kind === "allow_always");
    const hasReject = options.some(({decision}) => decision === "decline");
    return hasAllow && hasReject ? options : undefined;
}

export function fileChangeDecisionOptions(): DecisionOption<FileChangeApprovalDecision>[] {
    return [
        decisionOption(ApprovalOptionId.AllowOnce, "Allow once", "allow_once", "accept"),
        decisionOption(
            ApprovalOptionId.AllowAlways,
            "Allow for session",
            "allow_always",
            "acceptForSession",
            "Remember this approval until the Codex session ends",
        ),
        decisionOption(ApprovalOptionId.RejectOnce, "Reject", "reject_once", "decline"),
    ];
}

export function permissionProfileOptions(): acp.PermissionOption[] {
    return [
        permissionOption(
            ApprovalOptionId.AllowPermissionsForTurn,
            "Allow once",
            "allow_once",
            "Grant the complete requested permission profile for this turn",
        ),
        permissionOption(
            ApprovalOptionId.AllowPermissionsForSession,
            "Allow for session",
            "allow_always",
            "Grant the complete requested permission profile until the Codex session ends",
        ),
        permissionOption(ApprovalOptionId.RejectPermissions, "Reject", "reject_once"),
    ];
}

function parseAvailableCommandDecisions(
    params: CommandParamsWithAvailableDecisions,
): CommandExecutionApprovalDecision[] | undefined {
    if (!Array.isArray(params.availableDecisions) || params.availableDecisions.length === 0) {
        return undefined;
    }
    const decisions: CommandExecutionApprovalDecision[] = [];
    for (const candidate of params.availableDecisions) {
        const decision = parseCommandDecision(candidate, params);
        if (!decision) return undefined;
        decisions.push(decision);
    }
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

function decisionOption<T>(
    optionId: string,
    name: string,
    kind: acp.PermissionOptionKind,
    decision: T,
    description?: string,
): DecisionOption<T> {
    return {option: permissionOption(optionId, name, kind, description), decision};
}

function permissionOption(
    optionId: string,
    name: string,
    kind: acp.PermissionOptionKind,
    description?: string,
): acp.PermissionOption {
    const meta = optionPermissionMeta(description);
    return {optionId, name, kind, ...(meta ? {_meta: meta} : {})};
}

function parseNetworkAmendment(value: unknown): NetworkPolicyAmendment | undefined {
    if (!isRecord(value) || typeof value["host"] !== "string") return undefined;
    const action = value["action"];
    if (action !== "allow" && action !== "deny") return undefined;
    return {host: value["host"], action};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
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
