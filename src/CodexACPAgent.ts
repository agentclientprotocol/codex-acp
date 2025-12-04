import * as acp from "@agentclientprotocol/sdk";
import type {PlanEntry, ToolCallContent} from "@agentclientprotocol/sdk";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {
    ClientRequest, EventMsg, FileChange, NewConversationResponse, PlanItemArg, TaskCompleteEvent
} from "./app-server";

import {applyPatch} from "diff";

interface AgentSession {
    pendingPrompt: AbortController | null;
}

export class CodexACPAgent implements acp.Agent {
    private connection: acp.AgentSideConnection;
    private sessions: Map<string, AgentSession>;
    private codexConnection: MessageConnection;

    constructor(connection: acp.AgentSideConnection, codexConnection: MessageConnection) {
        this.connection = connection;
        this.sessions = new Map();
        this.codexConnection = codexConnection;
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: false,
            },
        };
    }

    async newSession(
        _params: acp.NewSessionRequest,
    ): Promise<acp.NewSessionResponse> {
        const initRequest: Omit<ClientRequest, "id"> = {
            method: "initialize",
            params: {
                clientInfo: {
                    name: "CodexConsoleClient",
                    version: "0.1.0",
                    title: "Sample"
                }
            }
        }

        await this.codexConnection.sendRequest(initRequest.method, initRequest.params)

        const newConversationRequest: Omit<ClientRequest, "id"> = {
            method: "newConversation",
            params: {
                model: null,
                modelProvider: null,
                profile: null,
                cwd: null,
                approvalPolicy: "never",
                sandbox: null,
                config: null,
                baseInstructions: null,
                developerInstructions: null,
                compactPrompt: null,
                includeApplyPatchTool: false,
            }
        }
        const newConversationResponse: NewConversationResponse = await this.codexConnection.sendRequest(newConversationRequest.method, newConversationRequest.params)

        const sessionId = newConversationResponse.conversationId;
        this.sessions.set(sessionId, {
            pendingPrompt: null,
        });

        return {
            sessionId,
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
    ): Promise<acp.AuthenticateResponse | void> {
        //TODO
        return {};
    }

    async setSessionMode(
        _params: acp.SetSessionModeRequest,
    ): Promise<acp.SetSessionModeResponse> {
        //TODO
        return {};
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const session = this.sessions.get(params.sessionId);

        if (!session) {
            throw new Error(`Session ${params.sessionId} not found`);
        }

        session.pendingPrompt?.abort();
        session.pendingPrompt = new AbortController();

        const prompt = params.prompt.filter(b => b.type === "text")
            .map(b => b.text)
            .join(" ");

        try {
            await this.processMessage(params.sessionId, prompt);
        } catch (err) {
            if (session.pendingPrompt.signal.aborted) {
                return {stopReason: "cancelled"};
            }

            throw err;
        }

        session.pendingPrompt = null;

        return {
            stopReason: "end_turn",
        };
    }

    private async processMessage(
        sessionId: string,
        prompt: string
    ): Promise<void> {


        const addListenerRequest: Omit<ClientRequest, "id"> = {
            method: "addConversationListener",
            params: {
                conversationId: sessionId
            }
        }
        await this.codexConnection.sendRequest(addListenerRequest.method, addListenerRequest.params)

        this.codexConnection.onUnhandledNotification((data) => {
            const params = data.params;
            const msg = (params as { msg?: EventMsg })?.msg ?? null;
            if (!msg) {
                // TODO: log as error or explicitly ignore unknown types
                return;
            }
            this.onAgentMessage(sessionId, msg);
        })

        const sendUserMessage: Omit<ClientRequest, "id"> = {
            method: "sendUserMessage",
            params: {
                conversationId: sessionId,
                items: [
                    {
                        type: "text",
                        data: {
                            text: prompt
                        }
                    }
                ]
            }
        }
        await this.codexConnection.sendRequest(sendUserMessage.method, sendUserMessage.params)


        await new Promise((resolve) => {
            this.codexConnection.onNotification("codex/event/task_complete", (event: TaskCompleteEvent) => {
                resolve(event);
            });
        });
    }

    private async onAgentMessage(sessionId: string, event: EventMsg) {
        switch (event.type) {
            case "agent_reasoning":
                await this.connection.sessionUpdate({
                    sessionId: sessionId,
                    update: {
                        sessionUpdate: "tool_call",
                        kind: "think",
                        title: event.text,
                        status: "in_progress", //TODO why in_progress status ignored
                        toolCallId: this.generateRandomId(),
                    }
                });
                break;

            case "exec_command_begin":
                if (event.command[0] === "bash" || event.command[0] === "/bin/bash") {
                    const cmd = event.command[event.command.length - 1]!;
                    event.command = cmd.split(" "); //TODO probably will fail with quoted parameters
                }
                if (event.command[0] === "sed") {
                    await this.sendRead(sessionId, event.command[event.command.length - 1]!);
                    break;
                }
                await this.connection.sessionUpdate({
                    sessionId: sessionId,
                    update: {
                        sessionUpdate: "tool_call",
                        kind: "execute",
                        title: event.command.join(" "),
                        toolCallId: event.call_id,
                        status: "in_progress",
                        content: [ {type:"terminal", terminalId: event.call_id}]
                    }
                })
                break;
            case "exec_command_end":
                await this.connection.sessionUpdate({
                    sessionId: sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: event.call_id,
                        status: "completed"
                    }
                })
                break;
            case "exec_approval_request":
                break;
            case "patch_apply_begin":
                const diffs: ToolCallContent[] = [];
                for (const [path, change] of Object.entries(event.changes)) {
                    if (!change) continue;
                    const content = await this.mapChange(sessionId, path, change);
                    diffs.push(content);
                }
                await this.connection.sessionUpdate({
                    sessionId,
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: event.call_id,
                        title: "Editing files",
                        kind: "edit",
                        status: "completed",
                        content: diffs,
                    },
                });
                break;
            case "patch_apply_end":
                await this.connection.sessionUpdate({
                    sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: event.call_id,
                        status: event.success ? "completed" : "failed"
                    },
                });
                break;
            case "apply_patch_approval_request":
                break
            case "agent_message": {
                await this.sendText(sessionId, event.message);
                break;
            }
            case "plan_update":
                await this.connection.sessionUpdate({
                    sessionId: sessionId,
                    update: {
                        sessionUpdate: "plan",
                        entries: this.convertPlanItems(event.plan)
                    }
                });
                break;
            case "error":
                break;
            case "stream_error":
                break;
            case "get_history_entry_response":
            case "mcp_list_tools_response":
            case "list_custom_prompts_response":
            case "turn_aborted":
            case "entered_review_mode":
            case "exited_review_mode":
            case "raw_response_item":
            case "item_started":
            case "item_completed":
            case "agent_message_content_delta":
            case "reasoning_content_delta":
            case "reasoning_raw_content_delta":
            case "shutdown_complete":
            case "warning":
            case "task_started":
            case "task_complete":
            case "token_count":
            case "user_message":
            case "agent_message_delta":
            case "agent_reasoning_delta":
            case "agent_reasoning_raw_content":
            case "agent_reasoning_raw_content_delta":
            case "agent_reasoning_section_break":
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
        }
    }

    private convertPlanItems(items: Array<PlanItemArg>): PlanEntry[] {
        return items.map(value => (
            {
                status: value.status,
                content: value.step,
                priority: "medium"
            })
        )
    }

    private async sendText(sessionId: string, text: string) {
        await this.connection.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                    type: "text",
                    text,
                },
            },
        })
    }

    private generateRandomId(): string {
        return Math.random().toString(36).substring(2);
    }

    private async mapChange(sessionId: string, filePath: string, change: FileChange): Promise<ToolCallContent> {
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

    private async sendRead(sessionId: string, filePath: string): Promise<void> {
        const readId = this.generateRandomId();
        await this.connection.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: "tool_call",
                toolCallId: readId,
                title: "Reading project files",
                kind: "read",
                status: "completed",
                locations: [{path: filePath}],
            },
        });
    }


    async cancel(params: acp.CancelNotification): Promise<void> {
        //TODO not supported yet
        this.codexConnection.end()
        this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
    }
}