import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {ApprovalHandler} from "./CodexAppServerClient";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse
} from "./app-server/v2";
import type {ToolCallContent} from "@agentclientprotocol/sdk/dist/schema/types.gen";
import {logger} from "./Logger";
import {stripShellPrefix} from "./CodexEventHandler";
import {ApprovalOptionId} from "./ApprovalOptionId";

const APPROVAL_OPTIONS: acp.PermissionOption[] = [
    { optionId: ApprovalOptionId.AllowOnce, name: "Allow Once", kind: "allow_once" },
    { optionId: ApprovalOptionId.AllowForSession, name: "Allow for Session", kind: "allow_always" },
    { optionId: ApprovalOptionId.RejectOnce, name: "Reject", kind: "reject_once" },
];

// Pair each displayed ACP option with the exact Codex decision it represents,
// so response conversion does not reconstruct decisions from labels or metadata.
type CommandDecisionOption = {
    option: acp.PermissionOption;
    decision: CommandExecutionApprovalDecision;
};

export class CodexApprovalHandler implements ApprovalHandler {
    private readonly connection: acp.AgentSideConnection;
    private readonly sessionState: SessionState;

    constructor(
        connection: acp.AgentSideConnection,
        sessionState: SessionState
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
    }

    async handleCommandExecution(
        params: CommandExecutionRequestApprovalParams
    ): Promise<CommandExecutionRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildCommandPermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertCommandResponse(response, params);
        } catch (error) {
            logger.error("Error requesting command execution permission", error);
            return { decision: "cancel" };
        }
    }

    async handleFileChange(
        params: FileChangeRequestApprovalParams
    ): Promise<FileChangeRequestApprovalResponse> {
        try {
            const sessionId = this.sessionState.sessionId;
            const acpRequest = this.buildFileChangePermissionRequest(sessionId, params);
            const response = await this.connection.requestPermission(acpRequest);
            return this.convertFileChangeResponse(response);
        } catch (error) {
            logger.error("Error requesting file change permission", error);
            return { decision: "cancel" };
        }
    }

    private buildCommandPermissionRequest(
        sessionId: string,
        params: CommandExecutionRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const reasonContent = this.createContentFromReason(params.reason ?? null);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "execute",
                status: "pending",
                content: reasonContent ? [reasonContent] : null,
                rawInput: params.command ? { command: stripShellPrefix(params.command), cwd: params.cwd } : null,
            },
            options: this.buildCommandDecisionOptions(params).map(({ option }) => option),
        };
    }

    private buildCommandDecisionOptions(
        params: CommandExecutionRequestApprovalParams
    ): CommandDecisionOption[] {
        // Older app-server versions did not send availableDecisions; they only
        // sent proposed amendment fields. Reconstruct that older decision list
        // as a compatibility fallback.
        const decisions = params.availableDecisions ?? this.buildLegacyFallbackCommandDecisions(params);
        let execAmendmentCount = 0;
        let networkAmendmentCount = 0;

        return decisions.map((decision) => {
            let amendmentIndex = 0;
            if (typeof decision !== "string" && "acceptWithExecpolicyAmendment" in decision) {
                amendmentIndex = execAmendmentCount++;
            } else if (typeof decision !== "string" && "applyNetworkPolicyAmendment" in decision) {
                amendmentIndex = networkAmendmentCount++;
            }
            return this.convertCommandDecisionToOption(decision, amendmentIndex);
        });
    }

    private buildLegacyFallbackCommandDecisions(
        params: CommandExecutionRequestApprovalParams
    ): CommandExecutionApprovalDecision[] {
        const decisions: CommandExecutionApprovalDecision[] = ["accept", "acceptForSession"];

        if (params.proposedExecpolicyAmendment) {
            decisions.push({
                acceptWithExecpolicyAmendment: {
                    execpolicy_amendment: params.proposedExecpolicyAmendment
                }
            });
        }

        for (const amendment of params.proposedNetworkPolicyAmendments ?? []) {
            decisions.push({
                applyNetworkPolicyAmendment: {
                    network_policy_amendment: amendment
                }
            });
        }

        decisions.push("decline");
        return decisions;
    }

    private convertCommandDecisionToOption(
        decision: CommandExecutionApprovalDecision,
        amendmentIndex: number
    ): CommandDecisionOption {
        if (decision === "accept") {
            return {
                option: { optionId: ApprovalOptionId.AllowOnce, name: "Yes, proceed", kind: "allow_once" },
                decision
            };
        }

        if (decision === "acceptForSession") {
            return {
                option: {
                    optionId: ApprovalOptionId.AllowForSession,
                    name: "Yes, and don't ask again for this exact command",
                    kind: "allow_always"
                },
                decision
            };
        }

        if (decision === "decline") {
            return {
                option: {
                    optionId: ApprovalOptionId.RejectOnce,
                    name: "No, and tell Codex what to do differently",
                    kind: "reject_once"
                },
                decision
            };
        }

        if (decision === "cancel") {
            return {
                option: {
                    optionId: ApprovalOptionId.Cancel,
                    name: "No, and tell Codex what to do differently",
                    kind: "reject_once"
                },
                decision
            };
        }

        if ("acceptWithExecpolicyAmendment" in decision) {
            // This amendment corresponds to a Codex exec-policy
            // `prefix_rule(..., decision="allow")`, not session-scoped approval.
            return {
                option: {
                    optionId: this.indexedOptionId(ApprovalOptionId.AllowCommandPrefixRule, amendmentIndex),
                    name: this.commandPrefixApprovalLabel(
                        decision.acceptWithExecpolicyAmendment.execpolicy_amendment
                    ),
                    kind: "allow_always"
                },
                decision
            };
        }

        return {
            option: {
                optionId: this.indexedOptionId(ApprovalOptionId.ApplyNetworkPolicyAmendment, amendmentIndex),
                name: this.networkPolicyApprovalLabel(
                    decision.applyNetworkPolicyAmendment.network_policy_amendment
                ),
                kind: decision.applyNetworkPolicyAmendment.network_policy_amendment.action === "deny"
                    ? "reject_always"
                    : "allow_always"
            },
            decision
        };
    }

    private commandPrefixApprovalLabel(execpolicyAmendment: string[]): string {
        const commandPrefix = execpolicyAmendment.join(" ");
        if (commandPrefix === "") {
            return "Yes, and don't ask again for similar commands";
        }
        return `Yes, and don't ask again for commands that start with \`${commandPrefix}\``;
    }

    private networkPolicyApprovalLabel(
        amendment: { host: string; action: "allow" | "deny" }
    ): string {
        const decision = amendment.action === "deny" ? "No" : "Yes";
        return `${decision}, and don't ask again for network access to \`${amendment.host}\``;
    }

    // ACP responses only return the selected optionId. The legacy network field
    // is plural and availableDecisions is an array, so repeated amendments need
    // unique IDs while the common single-amendment ID stays stable.
    private indexedOptionId(optionId: ApprovalOptionId, index: number): ApprovalOptionId | string {
        return index === 0 ? optionId : `${optionId}:${index}`;
    }

    private createContentFromReason(reason: string | null): ToolCallContent | null {
        if (reason === null || reason === "") {
            return null;
        }
        return {
            type: "content",
            content: {
                type: "text",
                text: reason
            }
        }
    }

    private buildFileChangePermissionRequest(
        sessionId: string,
        params: FileChangeRequestApprovalParams
    ): acp.RequestPermissionRequest {
        const reasonContent = this.createContentFromReason(params.reason ?? null);
        return {
            sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "edit",
                status: "pending",
                content: reasonContent ? [reasonContent] : null,
            },
            options: APPROVAL_OPTIONS,
        };
    }

    private convertCommandResponse(
        response: acp.RequestPermissionResponse,
        params: CommandExecutionRequestApprovalParams
    ): CommandExecutionRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return { decision: "cancel" };
        }

        const optionId = response.outcome.optionId;
        const selectedOption = this.buildCommandDecisionOptions(params)
            .find(({ option }) => option.optionId === optionId);
        if (selectedOption) {
            return { decision: selectedOption.decision };
        }

        return { decision: "decline" };
    }

    private convertFileChangeResponse(
        response: acp.RequestPermissionResponse
    ): FileChangeRequestApprovalResponse {
        if (response.outcome.outcome === "cancelled") {
            return { decision: "cancel" };
        }

        const optionId = response.outcome.optionId;
        if (optionId === ApprovalOptionId.AllowOnce) {
            return { decision: "accept" };
        } else if (optionId === ApprovalOptionId.AllowForSession) {
            return { decision: "acceptForSession" };
        } else {
            return { decision: "cancel" };
        }
    }
}
