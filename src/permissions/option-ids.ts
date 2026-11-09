export const ApprovalOptionId = {
    AllowOnce: "allow_once",
    AllowForSession: "allow_for_session",
    Decline: "decline",
    Cancel: "cancel",
    AcceptWithExecpolicyAmendment: "accept_execpolicy_amendment",
    ApplyNetworkPolicyAmendment: "apply_network_policy_amendment",
    AllowPermissionsForTurn: "allow_permissions_turn",
    AllowPermissionsForTurnWithStrictAutoReview: "allow_permissions_turn_strict_auto_review",
    AllowPermissionsForSession: "allow_permissions_session",
    RejectPermissions: "reject_permissions",
} as const;

export type ApprovalOptionId = typeof ApprovalOptionId[keyof typeof ApprovalOptionId];

export const McpApprovalOptionId = {
    AllowOnce: "allow_once",
    AllowSession: "allow_session",
    AllowAlways: "allow_always",
    Decline: "decline",
    Cancel: "cancel",
} as const;

export type McpApprovalOptionId = typeof McpApprovalOptionId[keyof typeof McpApprovalOptionId];
