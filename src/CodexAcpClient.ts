import {isCodexAuthRequest} from "./CodexAuthMethod";
import * as acp from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {RequestError} from "@agentclientprotocol/sdk";
import open from "open";
import type {ClientInfo, ServerNotification} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";

/**
 * API for accessing the Codex App Server using ACP requests.
 * Converts ACP requests into corresponding app-server operations.
 */
export class CodexAcpClient {

    private readonly codexClient: CodexAppServerClient;
    private readonly config: JsonObject | null;
    private readonly modelProvider: string | null;

    constructor(codexClient: CodexAppServerClient, codexConfig?: JsonObject, modelProvider?: string) {
        this.codexClient = codexClient;
        this.config = codexConfig ?? null;
        this.modelProvider = modelProvider ?? null;
    }

    private readonly defaultClientInfo: ClientInfo = {
        name: "codex-acp", title: "Codex ACP", version: "0.0.5"
    };

    async initialize(request: acp.InitializeRequest): Promise<void> {
        await this.codexClient.initialize({
            clientInfo: {
                name: request.clientInfo?.name ?? this.defaultClientInfo.name,
                version: request.clientInfo?.version ?? this.defaultClientInfo.version,
                title: request.clientInfo?.title ?? this.defaultClientInfo.title,
            }
        });
    }

    async authenticate(authRequest: acp.AuthenticateRequest): Promise<Boolean> {
        if (!isCodexAuthRequest(authRequest)) {
            throw RequestError.invalidRequest();
        }
        switch (authRequest.methodId) {
            case "api-key":
                await this.codexClient.accountLogin({
                    type: "apiKey",
                    apiKey: authRequest._meta.apiKey
                });
                break;
            case "chat-gpt":
                const loginResponse = await this.codexClient.accountLogin({ type: "chatgpt" });
                if (loginResponse.type == "chatgpt") {
                    await open(loginResponse.authUrl);
                }
                break;
        }
        const result = await this.codexClient.awaitLoginCompleted()
        return result.success;
    }

    async authRequired(): Promise<Boolean> {
        const response = await this.codexClient.accountRead({refreshToken: false})
        return response.requiresOpenaiAuth || !response.account;
    }

    /**
     * Returns a new session ID.
     */
    async newSession(request: acp.NewSessionRequest): Promise<string> {
        const response = await this.codexClient.threadStart({
            config: this.config,
            modelProvider: this.modelProvider,
            model: null,
            cwd: request.cwd,
            approvalPolicy: "never",
            sandbox: null,
            baseInstructions: null,
            developerInstructions: null,
        });
        return response.thread.id;
    }

    async sendPrompt(request: acp.PromptRequest, eventHandler: (result: ServerNotification) => void): Promise<void> {
        this.codexClient.onServerNotification(eventHandler);

        const input = request.prompt.filter(b => b.type === "text")
            .map(b => b.text)
            .join(" ");

        await this.codexClient.turnStart({
            threadId: request.sessionId,
            input: [{type: "text", text: input}],
            approvalPolicy: null,
            sandboxPolicy: null,
            summary: null,
            cwd: null,
            effort: null,
            model: null,
        });

        await this.codexClient.awaitTurnCompleted();
    }

}

export type JsonObject = { [key in string]?: JsonValue }