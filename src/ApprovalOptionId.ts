export const ApprovalOptionId = {
    AllowOnce: "allow_once",
    AllowAlways: "allow_always",
    RejectOnce: "reject_once",
    AcceptWithExecpolicyAmendment: "accept_execpolicy_amendment",
    ApplyNetworkPolicyAmendment: "apply_network_policy_amendment",
    AllowPermissionsForTurn: "allow_permissions_turn",
    AllowPermissionsForSession: "allow_permissions_session",
    RejectPermissions: "reject_permissions",
} as const;

export type ApprovalOptionId = typeof ApprovalOptionId[keyof typeof ApprovalOptionId];
