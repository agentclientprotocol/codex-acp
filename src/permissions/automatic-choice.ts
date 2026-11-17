import type * as acp from "@agentclientprotocol/sdk/unstable";
import {ApprovalOptionId} from "./option-ids";

export const APPROVAL_POLICY_META = "com.microsoft.amplifier.approval-policy";
export const AUTOMATIC_CHOICE_PRODUCER = "agentclientprotocol.codex-acp";

/** An optional host policy capability, separate from reusable approvals. */
export function supportsAutomaticChoice(meta: Record<string, unknown> | null | undefined): boolean {
    const value = meta?.[APPROVAL_POLICY_META];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const profile = value as Record<string, unknown>;
    return profile["version"] === 1 && profile["owner"] === "instance" && profile["automaticChoice"] === true
        && typeof profile["instanceId"] === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile["instanceId"]);
}

export function automaticChoiceCapability(enabled: boolean): Record<string, unknown> {
    return enabled ? {[APPROVAL_POLICY_META]: {
        version: 1, owner: "instance", producer: AUTOMATIC_CHOICE_PRODUCER, automaticChoice: true,
    }} : {};
}

/** The ordinary turn grant, not the separate strict-review or session grant. */
export function withAutomaticTurnChoice<T extends acp.RequestPermissionRequest["toolCall"]>(
    toolCall: T, enabled: boolean,
): T {
    if (!enabled) return toolCall;
    return {...toolCall, _meta: {...toolCall._meta, [APPROVAL_POLICY_META]: {
        automaticChoice: {version: 1, producer: AUTOMATIC_CHOICE_PRODUCER,
            allowOptionId: ApprovalOptionId.AllowPermissionsForTurn},
    }}};
}
