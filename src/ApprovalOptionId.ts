export const ApprovalOptionId = {
    AllowOnce: "allow_once",
    AllowForSession: "allow_for_session",
    AllowPersist: "allow_persist",
    AllowCommandPrefixRule: "allow_command_prefix_rule",
    ApplyNetworkPolicyAmendment: "apply_network_policy_amendment",
    RejectOnce: "reject_once",
    Cancel: "cancel",
} as const;

export type ApprovalOptionId = typeof ApprovalOptionId[keyof typeof ApprovalOptionId];
