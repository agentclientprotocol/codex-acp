import * as acp from "@agentclientprotocol/sdk";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {CodexClient} from "./CodexClient";
import {CodexEventHandler} from "./CodexEventHandler";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import {CodexAuthMethods, type CodexAuthRequest, isCodexAuthRequest} from "./CodexAuthMethod";
import {RequestError} from "@agentclientprotocol/sdk";


export interface SessionState {
    sessionId: string,
    seenReasoningDeltas: boolean;
    pendingPrompt: AbortController | null;
}

export class CodexACPAgent implements acp.Agent {
    private readonly name: string = "codex-appserver-acp";
    private readonly version: string = "0.1.0";
    private readonly title: string = "Codex ACP";

    private readonly codexClient: CodexClient;
    private readonly connection: acp.AgentSideConnection;
    private readonly config: JsonObject | null;
    private readonly modelProvider: string | null;
    private readonly defaultAuthRequest: CodexAuthRequest | null;

    private readonly sessions: Map<string, SessionState>;

    constructor(
        connection: acp.AgentSideConnection,
        codexConnection: MessageConnection,
        codexConfig?: JsonObject,
        modelProvider?: string,
        defaultAuthRequest?: CodexAuthRequest,
    ) {
        this.sessions = new Map();
        this.codexClient = new CodexClient(codexConnection);
        this.connection = connection;
        this.config = codexConfig ?? null;
        this.modelProvider = modelProvider ?? null;
        this.defaultAuthRequest = defaultAuthRequest ?? null;
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        await this.codexClient.initialize({
            clientInfo: {
                name: _params.clientInfo?.name ?? this.name,
                version: _params.clientInfo?.version ?? this.version,
                title: _params.clientInfo?.title ?? this.title,
            }
        });
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: false,
            },
            authMethods: CodexAuthMethods,
        };
    }

    async newSession(
        _params: acp.NewSessionRequest,
    ): Promise<acp.NewSessionResponse> {
        if (!await this.codexClient.loginStatus()) {
            if (this.defaultAuthRequest) {
                await this.authenticate(this.defaultAuthRequest)
            } else {
                throw RequestError.authRequired();
            }
        }

        const threadStartResponse = await this.codexClient.threadStart({
            config: this.config,
            modelProvider: this.modelProvider,
            model: null,
            cwd: _params.cwd,
            approvalPolicy: "never",
            sandbox: null,
            baseInstructions: null,
            developerInstructions: null,
        })

        const sessionId = threadStartResponse.thread.id;
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
    ): Promise<acp.AuthenticateResponse> {
        if (!isCodexAuthRequest(_params)) {
            throw RequestError.invalidRequest();
        }
        let authResult: Boolean;
        switch (_params.methodId) {
            case "api-key":
                authResult = await this.codexClient.loginWithApiKey(_params._meta.apiKey);
                break;
            case "chat-gpt":
                authResult = await this.codexClient.loginWithChatGpt();
                break;
        }
        if (!authResult) {
            throw RequestError.invalidParams();
        }
        return { };
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
        const messageHandler = new CodexEventHandler(this.connection, sessionState);

        this.codexClient.onServerNotification(notification => {
            messageHandler.handleNotification(notification);
        });

        await this.codexClient.turnStart({
            threadId: sessionState.sessionId,
            input: [{type: "text", text: prompt}],
            approvalPolicy: null,
            sandboxPolicy: null,
            summary: null,
            cwd: null,
            effort: null,
            model: null,
        })

        await this.codexClient.waitForCompletion()
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        //TODO not supported yet
        await this.codexClient.close()
        this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
    }
}

export type JsonObject = { [key in string]?: JsonValue }