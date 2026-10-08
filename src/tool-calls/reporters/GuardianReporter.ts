import type * as acp from "@agentclientprotocol/sdk";
import type {
    GuardianApprovalReview,
    GuardianApprovalReviewAction,
    GuardianApprovalReviewStatus,
    GuardianCommandSource,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
} from "../../app-server/v2";
import {textContent} from "../AcpToolCallRenderer";
import type {ToolFacts} from "../ToolFacts";

type GuardianApprovalReviewNotification =
    | ItemGuardianApprovalReviewStartedNotification
    | ItemGuardianApprovalReviewCompletedNotification;

/**
 * Reports a Codex guardian approval review.
 * The reviewed action is the input. A client without the AIR `rawInputRendering` capability also reads it as text.
 * The review verdict is the result.
 */
export class GuardianReporter {
    private readonly activeReviews = new Set<string>();

    started(event: ItemGuardianApprovalReviewStartedNotification): ToolFacts {
        if (this.activeReviews.has(event.reviewId)) return reviewFacts(event, "update");
        this.activeReviews.add(event.reviewId);
        return reviewFacts(event, "start");
    }

    completed(event: ItemGuardianApprovalReviewCompletedNotification): ToolFacts {
        return reviewFacts(event, this.activeReviews.delete(event.reviewId) ? "update" : "start");
    }
}

function guardianApprovalReviewToolCallId(reviewId: string): string {
    return `guardian_assessment:${reviewId}`;
}

function reviewFacts(event: GuardianApprovalReviewNotification, report: ToolFacts["report"]): ToolFacts {
    const action = createGuardianApprovalReviewActionSummary(event.action);
    return {
        toolCallId: guardianApprovalReviewToolCallId(event.reviewId),
        report,
        ...(report === "start" ? {kind: "think" as const, title: "Guardian Review"} : {}),
        status: toAcpGuardianApprovalReviewStatus(event.review.status),
        input: {action: event.action},
        ...(action ? {readableInput: `Action: ${action}`} : {}),
        result: [reviewVerdict(event.review, null)],
        standard: {
            // A client that is not AIR gets one text with the action, and the whole event.
            content: [reviewVerdict(event.review, action)],
            ...(report === "start" ? {rawInput: event} : {rawInput: null, rawOutput: event}),
        },
    };
}

/** The review verdict as text. The text names the action only when `action` is set. */
function reviewVerdict(review: GuardianApprovalReview, action: string | null): acp.ToolCallContent {
    const lines = [`Status: ${formatGuardianApprovalReviewStatus(review.status)}`];
    if (action) lines.push(`Action: ${action}`);
    if (review.riskLevel) lines.push(`Risk: ${review.riskLevel}`);
    if (review.userAuthorization) lines.push(`Authorization: ${review.userAuthorization}`);
    if (review.rationale?.trim()) lines.push(`Rationale: ${review.rationale}`);
    return textContent(lines.join("\n"));
}

function toAcpGuardianApprovalReviewStatus(status: GuardianApprovalReviewStatus): acp.ToolCallStatus {
    switch (status) {
        case "inProgress":
            return "in_progress";
        case "approved":
            return "completed";
        case "denied":
        case "aborted":
        case "timedOut":
            return "failed";
    }
}

function formatGuardianApprovalReviewStatus(status: GuardianApprovalReviewStatus): string {
    switch (status) {
        case "inProgress":
            return "In progress";
        case "approved":
            return "Approved";
        case "denied":
            return "Denied";
        case "aborted":
            return "Aborted";
        case "timedOut":
            return "Timed out";
    }
}

function createGuardianApprovalReviewActionSummary(action: GuardianApprovalReviewAction): string | null {
    switch (action.type) {
        case "command":
            return `${guardianCommandSourceLabel(action.source)} ${action.command}`;
        case "execve": {
            const command = action.argv.length > 0 ? action.argv : [action.program];
            return `${guardianCommandSourceLabel(action.source)} ${shellJoin(command)}`;
        }
        case "writeStdin":
            return `write stdin to process ${action.processId}`;
        case "applyPatch":
            if (action.files.length === 1) {
                return `apply_patch touching ${action.files[0]}`;
            }
            return `apply_patch touching ${action.files.length} files`;
        case "networkAccess": {
            const label = action.target.length > 0 ? action.target : action.host;
            return `network access to ${label}`;
        }
        case "mcpToolCall": {
            const label = action.connectorName ?? action.server;
            return `MCP ${action.toolName} on ${label}`;
        }
        case "requestPermissions":
            return action.reason ?? "request additional permissions";
    }
}

function guardianCommandSourceLabel(source: GuardianCommandSource): string {
    switch (source) {
        case "shell":
            return "shell";
        case "unifiedExec":
            return "exec";
    }
}

function shellJoin(args: string[]): string {
    return args.map(shellQuote).join(" ");
}

function shellQuote(arg: string): string {
    if (arg.length === 0) {
        return "''";
    }
    if (/^[A-Za-z0-9_/:=+.,@%-]+$/.test(arg)) {
        return arg;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
