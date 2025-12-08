import * as acp from "@agentclientprotocol/sdk";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {NewConversationResponse} from "./app-server";
import {CodexClient} from "./CodexClient";
import {CodexEventHandler} from "./CodexEventHandler";

export interface SessionState {
    sessionId: string,
    seenReasoningDeltas: boolean;
    pendingPrompt: AbortController | null;
}

export class CodexACPAgent implements acp.Agent {
    private readonly sessions: Map<string, SessionState>;
    private readonly codexClient: CodexClient;
    private readonly messageHandler: CodexEventHandler;

    constructor(connection: acp.AgentSideConnection, codexConnection: MessageConnection) {
        this.sessions = new Map();
        this.codexClient = new CodexClient(codexConnection);
        this.messageHandler = new CodexEventHandler(connection);
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        await this.codexClient.initialize({
            clientInfo: {
                name: "CodexConsoleClient",
                version: "0.1.0",
                title: "Codex ACP"
            }
        });
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
        const newConversationResponse: NewConversationResponse = await this.codexClient.newConversation({
            model: null,
            modelProvider: null,
            profile: null,
            cwd: _params.cwd,
            approvalPolicy: "never",
            sandbox: null,
            config: null,
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
        })

        const sessionId = newConversationResponse.conversationId;
        this.sessions.set(sessionId, {
            sessionId: sessionId,
            seenReasoningDeltas: false,
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
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) {
            throw new Error(`Session ${params.sessionId} not found`);
        }

        sessionState.pendingPrompt?.abort();
        sessionState.pendingPrompt = new AbortController();

        const prompt = params.prompt.filter(b => b.type === "text")
            .map(b => b.text)
            .join(" ");

        try {
            await this.processMessage(sessionState, prompt);
        } catch (err) {
            if (sessionState.pendingPrompt.signal.aborted) {
                return {stopReason: "cancelled"};
            }

            throw err;
        }

        sessionState.pendingPrompt = null;

        return {
            stopReason: "end_turn",
        };
    }

    private async processMessage(
        sessionState: SessionState,
        prompt: string
    ): Promise<void> {
        await this.codexClient.addConversationListener({
            conversationId: sessionState.sessionId,
            experimentalRawEvents: false,
        })

        this.codexClient.onMessageEvent(event => this.messageHandler.handleEvent(sessionState, event));

        await this.codexClient.sendUserMessage({
            conversationId: sessionState.sessionId,
            items: [
                {
                    type: "text",
                    data: {
                        text: prompt
                    }
                }
            ]
        })

        await this.codexClient.waitForCompletion()
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        //TODO not supported yet
        await this.codexClient.close()
        this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
    }
}