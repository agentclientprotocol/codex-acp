export const McpApprovalOptionId = {
    AllowOnce: "allow_once",
    AllowSession: "allow_session",
    AllowAlways: "allow_always",
    Decline: "decline",
} as const;

export type McpApprovalOptionId = typeof McpApprovalOptionId[keyof typeof McpApprovalOptionId];
