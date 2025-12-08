import type {
    AgentMessageEvent,
    AgentReasoningEvent, AgentReasoningSectionBreakEvent, EventMsg, ExecCommandBeginEvent,
    ExecCommandEndEvent, FileChange, PatchApplyBeginEvent, PatchApplyEndEvent,
    ReasoningContentDeltaEvent, ReasoningRawContentDeltaEvent, UpdatePlanArgs
} from "./app-server";
import type {SessionState} from "./CodexACPAgent";
import  {type PlanEntry, type ToolCallContent} from "@agentclientprotocol/sdk";

import {applyPatch} from "diff";
import {ACPSessionConnection} from "./ACPSessionConnection";
import * as acp from "@agentclientprotocol/sdk";

export class CodexEventHandler {

    private readonly connection: acp.AgentSideConnection;

    constructor(connection: acp.AgentSideConnection) {
        this.connection = connection;
    }

    async handleEvent(sessionState: SessionState, event: EventMsg) {
        const session = new ACPSessionConnection(this.connection, sessionState.sessionId);

        switch (event.type) {
            case "agent_reasoning":
                return this.handleAgentReasoning(session, sessionState, event);
            case "reasoning_content_delta":
            case "reasoning_raw_content_delta":
                return this.handleReasoningDelta(session, sessionState, event)
            case "agent_reasoning_section_break":
                return this.handleReasoningSectionBreak(session, sessionState, event)
            case "exec_command_begin":
                return this.handleCommandBegin(session, event);
            case "exec_command_end":
                return this.handleCommandEnd(session, event);
            case "patch_apply_begin":
                return await this.handlePatchApplyBegin(session, event);
            case "patch_apply_end":
                return await this.handlePatchApplyEnd(session, event);
            case "agent_message":
                return await this.handleAgentMessage(session, event);
            case "plan_update":
                return await this.handleUpdatePlan(session, event);
            //TODO handle other events
            case "error":
            case "stream_error":
            case "exec_approval_request":
            case "apply_patch_approval_request":
            case "token_count":
            case "agent_message_content_delta":
            //skipped events
            case "get_history_entry_response":
            case "mcp_list_tools_response":
            case "list_custom_prompts_response":
            case "turn_aborted":
            case "entered_review_mode":
            case "exited_review_mode":
            case "raw_response_item":
            case "item_started":
            case "item_completed":
            case "shutdown_complete":
            case "warning":
            case "task_started":
            case "task_complete":
            case "user_message":
            case "agent_message_delta":
            case "agent_reasoning_delta":
            case "agent_reasoning_raw_content":
            case "agent_reasoning_raw_content_delta":
            case "session_configured":
            case "mcp_tool_call_begin":
            case "mcp_tool_call_end":
            case "web_search_begin":
            case "web_search_end":
            case "exec_command_output_delta":
            case "view_image_tool_call":
            case "deprecation_notice":
            case "background_event":
            case "undo_started":
            case "undo_completed":
            case "turn_diff":
            case "mcp_startup_update":
            case "mcp_startup_complete":
            case "elicitation_request":
                break;
        }
    }

    private async handleAgentReasoning(session: ACPSessionConnection, sessionState: SessionState, event: AgentReasoningEvent){
        // Only send if we haven't seen delta events (non-streaming mode)
        if (!sessionState.seenReasoningDeltas) {
            await session.update({
                sessionUpdate: "agent_thought_chunk",
                content: {
                    type: "text",
                    text: event.text
                }
            });
        }
        // Reset the flag for next turn
        sessionState.seenReasoningDeltas = false;
    }

    private async handleReasoningDelta(session: ACPSessionConnection, sessionState: SessionState, event: ReasoningRawContentDeltaEvent | ReasoningContentDeltaEvent) {
        sessionState.seenReasoningDeltas = true;
        await session.update({
            sessionUpdate: "agent_thought_chunk",
            content: {
                type: "text",
                text: event.delta
            }
        });
    }

    private async handleReasoningSectionBreak(session: ACPSessionConnection, sessionState: SessionState, event: AgentReasoningSectionBreakEvent) {
        sessionState.seenReasoningDeltas = true;
        // Send spacing for section break
        await session.update({
            sessionUpdate: "agent_thought_chunk",
            content: {
                type: "text",
                text: "\n\n"
            }
        });
    }

    private async handleCommandBegin(session: ACPSessionConnection, event: ExecCommandBeginEvent) {
        if (event.command[0] === "bash" || event.command[0] === "/bin/bash") {
            const cmd = event.command[event.command.length - 1]!;
            event.command = cmd.split(" "); //TODO probably will fail with quoted parameters
        }
        if (event.command[0] === "sed") {
            const filePath = event.command[event.command.length - 1]!;
            return await session.update({
                sessionUpdate: "tool_call",
                toolCallId: event.call_id,
                title: "Reading project files",
                kind: "read",
                status: "in_progress",
                locations: [{path: filePath}],
            });
        }
        return await session.update({
            sessionUpdate: "tool_call",
            kind: "execute",
            title: event.command.join(" "),
            toolCallId: event.call_id,
            status: "in_progress",
            content: [ {type:"terminal", terminalId: event.call_id}]
        });
    }

    private async handleCommandEnd(session: ACPSessionConnection, event: ExecCommandEndEvent) {
        return await session.update({
            sessionUpdate: "tool_call_update",
            toolCallId: event.call_id,
            status: "completed"
        });
    }

    private async handleUpdatePlan(session: ACPSessionConnection, event: UpdatePlanArgs) {
        const plan: PlanEntry[] = event.plan.map(value => ({
                status: value.status,
                content: value.step,
                priority: "medium"
            })
        );
        return await session.update({
            sessionUpdate: "plan",
            entries: plan
        });
    }

    private async handlePatchApplyBegin(session: ACPSessionConnection, event: PatchApplyBeginEvent) {
        const diffs: ToolCallContent[] = [];
        for (const [path, change] of Object.entries(event.changes)) {
            if (!change) continue;
            const content = await this.createFileDiff(session.sessionId, path, change);
            diffs.push(content);
        }
        return await session.update({
            sessionUpdate: "tool_call",
            toolCallId: event.call_id,
            title: "Editing files",
            kind: "edit",
            status: "completed",
            content: diffs,
        });
    }

    private async handlePatchApplyEnd(session: ACPSessionConnection, event: PatchApplyEndEvent) {
        return await session.update({
            sessionUpdate: "tool_call_update",
            toolCallId: event.call_id,
            status: event.success ? "completed" : "failed"
        });
    }

    private async handleAgentMessage(session: ACPSessionConnection, event: AgentMessageEvent) {
        await session.update({
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: event.message,
            },
        })
    }

    private async createFileDiff(sessionId: string, filePath: string, change: FileChange): Promise<ToolCallContent> {
        const oldContent = await this.connection.readTextFile({
            sessionId: sessionId,
            path: filePath
        });

        let newContent
        switch (change.type) {
            case "delete":
                newContent = "";
                break;
            case "update":
                const patched = applyPatch(oldContent.content, change.unified_diff);
                if (patched === false) {
                    newContent = change.unified_diff;
                } else {
                    newContent = patched;
                }
                break;
            case "add":
                newContent = change.content;
                break;
        }

        return {
            type: "diff",
            oldText: oldContent.content,
            newText: newContent,
            path: filePath,
        }
    }
}
