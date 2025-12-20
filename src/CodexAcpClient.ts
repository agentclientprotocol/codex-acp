import {isCodexAuthRequest} from "./CodexAuthMethod";
import * as acp from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import {RequestError} from "@agentclientprotocol/sdk";
import open from "open";
import type {
    ClientInfo,
    ServerNotification,
    SetDefaultModelParams,
    SetDefaultModelResponse
} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {Model} from "./app-server/v2";
import {ModelId} from "./ModelId";

/**
 * API for accessing the Codex App Server using ACP requests.
 * Converts ACP requests into corresponding app-server operations.
 */
export class CodexAcpClient {

    private readonly codexClient: CodexAppServerClient;
    private readonly config: JsonObject;
    private readonly modelProvider: string | null;

    constructor(codexClient: CodexAppServerClient, codexConfig?: JsonObject, modelProvider?: string) {
        this.codexClient = codexClient;
        this.config = codexConfig ?? {};
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

    async logout(): Promise<void> {
        await this.codexClient.accountLogout();
        await this.codexClient.awaitAccountUpdated();
    }

    async authRequired(): Promise<Boolean> {
        const response = await this.codexClient.accountRead({refreshToken: false})
        return response.requiresOpenaiAuth && !response.account;
    }

    /**
     * Returns a new session ID.
     */
    async newSession(request: acp.NewSessionRequest): Promise<SessionMetadata> {
        const threadStartResponse = await this.codexClient.threadStart({
            config: this.config,
            modelProvider: this.modelProvider,
            model: null,
            cwd: request.cwd,
            approvalPolicy: "never",
            sandbox: null,
            baseInstructions: null,
            developerInstructions: null,
        });
        const codexModels = await this.fetchAvailableModels();
        if (codexModels.length === 0) {
            throw new Error("Codex did not return any models");
        }
        const currentModelId = ModelId.fromThreadResponse(threadStartResponse).toString();
        return {
            sessionId: threadStartResponse.thread.id,
            currentModelId: currentModelId,
            models: codexModels
        };
    }

    async sendPrompt(request: acp.PromptRequest, eventHandler: (result: ServerNotification) => void): Promise<void> {
        this.codexClient.onServerNotification(request.sessionId, eventHandler);

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

    async setModel(params: SetDefaultModelParams): Promise<SetDefaultModelResponse> {
        return this.codexClient.setModelRequest(params);
    }

    private async fetchAvailableModels(): Promise<Model[]> {
        const models: Model[] = [];
        let cursor: string | null = null;

        do {
            const response = await this.codexClient.listModels({ cursor, limit: null });
            models.push(...response.data);
            cursor = response.nextCursor;
        } while (cursor);

        return models;
    }
}

export type JsonObject = { [key in string]?: JsonValue }

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[]
}
