export const ApprovalOptionId = {
    AllowOnce: "allow_once",
    AllowAlways: "allow_always",
    RejectOnce: "reject_once",
} as const;

export type ApprovalOptionId = typeof ApprovalOptionId[keyof typeof ApprovalOptionId];
