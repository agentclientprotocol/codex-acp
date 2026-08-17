import type * as acp from "@agentclientprotocol/sdk";
import type {
    AdditionalPermissionProfile,
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    FileChangeApprovalDecision,
    NetworkPolicyAmendment,
} from "../app-server/v2";
import {ApprovalOptionId} from "./option-ids";

export type DecisionOption<T> = {option: acp.PermissionOption; decision: T};

export type CommandParamsWithAvailableDecisions = CommandExecutionRequestApprovalParams & {
    additionalPermissions?: AdditionalPermissionProfile | null;
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
        if (decision === "accept") {
            options.push(decisionOption(
                ApprovalOptionId.AllowOnce,
                params.networkApprovalContext ? "Yes, just this once" : "Yes, proceed",
                "allow_once",
                decision,
            ));
        } else if (decision === "acceptForSession") {
            options.push(decisionOption(
                ApprovalOptionId.AllowForSession,
                params.networkApprovalContext
                    ? "Yes, and allow this host for this conversation"
                    : params.additionalPermissions
                        ? "Yes, and allow these permissions for this session"
                        : "Yes, and don't ask again for this command in this session",
                "allow_always",
                decision,
            ));
        } else if (decision === "decline") {
            options.push(decisionOption(
                ApprovalOptionId.Decline,
                "No, continue without running it",
                "reject_once",
                decision,
            ));
        } else if (decision === "cancel") {
            options.push(decisionOption(
                ApprovalOptionId.Cancel,
                "No, and tell Codex what to do differently",
                "reject_once",
                decision,
            ));
        } else if ("acceptWithExecpolicyAmendment" in decision) {
            const prefix = renderExecPolicyPrefix(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
            if (prefix.includes("\n") || prefix.includes("\r")) continue;
            options.push(decisionOption(
                ApprovalOptionId.AcceptWithExecpolicyAmendment,
                `Yes, and don't ask again for commands that start with \`${prefix}\``,
                "allow_always",
                decision,
            ));
        } else {
            const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
            options.push(decisionOption(
                `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:${networkIndex++}`,
                amendment.action === "allow"
                    ? "Yes, and allow this host in the future"
                    : "No, and block this host in the future",
                amendment.action === "allow" ? "allow_always" : "reject_always",
                decision,
            ));
        }
    }

    const orderedOptions = [...options].sort(
        (left, right) => permissionOptionOrder(left.option) - permissionOptionOrder(right.option),
    );
    const hasAllow = orderedOptions.some(({option}) => option.kind === "allow_once" || option.kind === "allow_always");
    const hasReject = orderedOptions.some(({option}) => option.kind === "reject_once" || option.kind === "reject_always");
    const optionIds = orderedOptions.map(({option}) => option.optionId);
    const hasUniqueOptionIds = new Set(optionIds).size === optionIds.length;
    return hasAllow && hasReject && hasUniqueOptionIds ? orderedOptions : undefined;
}

function permissionOptionOrder(option: acp.PermissionOption): number {
    if (option.kind === "allow_once") return 0;
    if (option.kind === "allow_always") return 1;
    return 2;
}

export function fileChangeDecisionOptions(): DecisionOption<FileChangeApprovalDecision>[] {
    return [
        decisionOption(ApprovalOptionId.AllowOnce, "Yes, proceed", "allow_once", "accept"),
        decisionOption(
            ApprovalOptionId.AllowForSession,
            "Yes, and don't ask again for these files",
            "allow_always",
            "acceptForSession",
        ),
        decisionOption(
            ApprovalOptionId.Cancel,
            "No, and tell Codex what to do differently",
            "reject_once",
            "cancel",
        ),
    ];
}

export function permissionProfileOptions(): acp.PermissionOption[] {
    return [
        permissionOption(
            ApprovalOptionId.AllowPermissionsForTurn,
            "Yes, grant these permissions for this turn",
            "allow_once",
        ),
        permissionOption(
            ApprovalOptionId.AllowPermissionsForTurnWithStrictAutoReview,
            "Yes, grant for this turn with strict auto review",
            "allow_once",
        ),
        permissionOption(
            ApprovalOptionId.AllowPermissionsForSession,
            "Yes, grant these permissions for this session",
            "allow_always",
        ),
        permissionOption(
            ApprovalOptionId.RejectPermissions,
            "No, continue without permissions",
            "reject_once",
        ),
    ];
}

function parseAvailableCommandDecisions(
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
        const allowAmendment = params.proposedNetworkPolicyAmendments?.find(amendment => amendment.action === "allow");
        if (allowAmendment) {
            decisions.push({applyNetworkPolicyAmendment: {network_policy_amendment: allowAmendment}});
        }
        decisions.push("cancel");
        return decisions;
    }
    if (params.additionalPermissions) return ["accept", "cancel"];
    const decisions: CommandExecutionApprovalDecision[] = ["accept"];
    if (params.proposedExecpolicyAmendment) {
        decisions.push({
            acceptWithExecpolicyAmendment: {execpolicy_amendment: params.proposedExecpolicyAmendment},
        });
    }
    decisions.push("cancel");
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
): DecisionOption<T> {
    return {option: permissionOption(optionId, name, kind), decision};
}

function permissionOption(
    optionId: string,
    name: string,
    kind: acp.PermissionOptionKind,
): acp.PermissionOption {
    return {optionId, name, kind};
}

function renderExecPolicyPrefix(command: readonly string[]): string {
    const script = extractWrappedScript(command);
    if (script !== undefined) return script;
    if (command.some(value => value.includes("\0"))) return command.join(" ");
    return command.map(shlexQuote).join(" ");
}

function extractWrappedScript(command: readonly string[]): string | undefined {
    const executable = executableName(command[0]);
    if ((executable === "bash" || executable === "zsh" || executable === "sh")
        && command.length === 3
        && (command[1] === "-lc" || command[1] === "-c")) {
        return command[2];
    }
    if (executable !== "pwsh" && executable !== "powershell") return undefined;
    const allowedFlags = new Set(["-nologo", "-noprofile", "-command", "-c"]);
    for (let index = 1; index + 1 < command.length; index++) {
        const flag = command[index]?.toLowerCase();
        if (flag === undefined || !allowedFlags.has(flag)) return undefined;
        if (flag === "-command" || flag === "-c") return command[index + 1];
    }
    return undefined;
}

function executableName(command: string | undefined): string | undefined {
    let filename = command?.replaceAll("\\", "/").split("/").at(-1);
    while (filename !== undefined) {
        if (["bash", "zsh", "sh", "pwsh", "powershell"].includes(filename)) return filename;
        const dot = filename.lastIndexOf(".");
        if (dot <= 0) return undefined;
        filename = filename.slice(0, dot);
    }
    return undefined;
}

function shlexQuote(value: string): string {
    if (value.length === 0) return "''";
    const UNQUOTED = 1;
    const SINGLE_QUOTED = 2;
    const DOUBLE_QUOTED = 4;
    let offset = 0;
    let result = "";
    while (offset < value.length) {
        const start = offset;
        let allowed = UNQUOTED | SINGLE_QUOTED | DOUBLE_QUOTED;
        if (value[offset] === "^") {
            allowed = SINGLE_QUOTED;
            offset++;
        }
        while (offset < value.length) {
            const character = value[offset]!;
            let nextAllowed = allowed;
            if (!isShlexUnquoted(character)) nextAllowed &= ~UNQUOTED;
            if (character === "'" || character === "^" || character === "\\") nextAllowed &= ~SINGLE_QUOTED;
            if (character === "`" || character === "$" || character === "!" || character === "^") {
                nextAllowed &= ~DOUBLE_QUOTED;
            }
            if (nextAllowed === 0) break;
            allowed = nextAllowed;
            offset++;
        }
        const chunk = value.slice(start, offset);
        if ((allowed & UNQUOTED) !== 0) result += chunk;
        else if ((allowed & SINGLE_QUOTED) !== 0) result += `'${chunk}'`;
        else result += `"${chunk.replace(/["\\]/g, "\\$&")}"`;
    }
    return result;
}

function isShlexUnquoted(character: string): boolean {
    return /^[0-9A-Za-z]$/.test(character) || "+-./:@]_".includes(character);
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
