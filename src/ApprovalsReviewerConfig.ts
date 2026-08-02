import type {SessionConfigOption} from "@agentclientprotocol/sdk";
import type {ApprovalsReviewer} from "./app-server/v2";

export const APPROVALS_REVIEWER_CONFIG_ID = "approvals_reviewer";
export const USER_APPROVALS_REVIEWER = "user";
export const AUTO_APPROVALS_REVIEWER = "auto_review";

export type SelectableApprovalsReviewer =
    | typeof USER_APPROVALS_REVIEWER
    | typeof AUTO_APPROVALS_REVIEWER;

export function createApprovalsReviewerConfigOption(
    currentValue: SelectableApprovalsReviewer,
): SessionConfigOption {
    return {
        id: APPROVALS_REVIEWER_CONFIG_ID,
        name: "Approval reviewer",
        description: "Who reviews eligible approval requests",
        category: "_approvals_reviewer",
        type: "select",
        currentValue,
        options: [
            {
                value: USER_APPROVALS_REVIEWER,
                name: "User",
                description: "Ask the user to approve or deny requests",
            },
            {
                value: AUTO_APPROVALS_REVIEWER,
                name: "Auto-review",
                description: "Use a reviewer agent to assess eligible requests",
            },
        ],
    };
}

export function parseApprovalsReviewer(value: unknown): SelectableApprovalsReviewer | null {
    if (value === USER_APPROVALS_REVIEWER) return USER_APPROVALS_REVIEWER;
    if (value === AUTO_APPROVALS_REVIEWER) return AUTO_APPROVALS_REVIEWER;
    return null;
}

export function normalizeApprovalsReviewer(
    value: ApprovalsReviewer | null | undefined,
): SelectableApprovalsReviewer {
    return value === AUTO_APPROVALS_REVIEWER || value === "guardian_subagent"
        ? AUTO_APPROVALS_REVIEWER
        : USER_APPROVALS_REVIEWER;
}
