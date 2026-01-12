import {isCodexAuthRequest} from "./CodexAuthMethod";
import * as acp from "@agentclientprotocol/sdk";
import type {ApprovalHandler, CodexAppServerClient} from "./CodexAppServerClient";
import {RequestError} from "@agentclientprotocol/sdk";
import open from "open";
import type {
    ClientInfo,
    ServerNotification,
    SetDefaultModelParams,
    SetDefaultModelResponse
} from "./app-server";
import type {TurnCompletedNotification} from "./app-server/v2";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {Model} from "./app-server/v2";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import type {UserInput} from "./app-server/v2";
import type {EmbeddedResourceResource} from "@agentclientprotocol/sdk";

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
                const loginResponse = await this.codexClient.accountLogin({type: "chatgpt"});
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

    async resumeSession(request: acp.ResumeSessionRequest, agentMode: AgentMode): Promise<SessionMetadata> {
        const response = await this.codexClient.threadResume({
            approvalPolicy: agentMode.approvalPolicy,
            sandbox: agentMode.sandboxMode,
            baseInstructions: null,
            config: this.config,
            cwd: request.cwd,
            developerInstructions: null,
            history: null,
            model: null,
            modelProvider: this.modelProvider,
            path: null,
            threadId: request.sessionId,
        });
        const codexModels = await this.fetchAvailableModels();
        return {
            sessionId: request.sessionId,
            currentModelId: response.model,
            models: codexModels,
            agentMode: agentMode
        }
    }

    /**
     * Returns a new session ID.
     */
    async newSession(request: acp.NewSessionRequest, agentMode: AgentMode): Promise<SessionMetadata> {
        const threadStartResponse = await this.codexClient.threadStart({
            config: this.config,
            modelProvider: this.modelProvider,
            model: null,
            cwd: request.cwd,
            approvalPolicy: agentMode.approvalPolicy,
            sandbox: agentMode.sandboxMode,
            baseInstructions: null,
            developerInstructions: null,
            experimentalRawEvents: false
        });

        const codexModels = await this.fetchAvailableModels();
        if (codexModels.length === 0) {
            throw new Error("Codex did not return any models");
        }
        const currentModelId = ModelId.fromThreadResponse(threadStartResponse).toString();

        return {
            sessionId: threadStartResponse.thread.id,
            currentModelId: currentModelId,
            models: codexModels,
            agentMode: agentMode,
        };
    }

    async sendPrompt(
        request: acp.PromptRequest,
        agentMode: AgentMode,
        eventHandler: (result: ServerNotification) => void,
        approvalHandler: ApprovalHandler
    ): Promise<TurnCompletedNotification> {
        this.codexClient.onServerNotification(request.sessionId, eventHandler);
        this.codexClient.onApprovalRequest(request.sessionId, approvalHandler);

        const input = buildPromptItems(request.prompt);

        await this.codexClient.turnStart({
            outputSchema: null,
            threadId: request.sessionId,
            input: input,
            approvalPolicy: agentMode.approvalPolicy,
            sandboxPolicy: agentMode.sandboxPolicy,
            summary: null,
            cwd: null,
            effort: null,
            model: null
        });

        // Wait for turn completion
        // If turnInterrupt() was called, Codex will send turn/completed event with status "interrupted"
        return await this.codexClient.awaitTurnCompleted();
    }

    async setModel(params: SetDefaultModelParams): Promise<SetDefaultModelResponse> {
        return this.codexClient.setModelRequest(params);
    }

    async turnInterrupt(params: { threadId: string, turnId: string }): Promise<void> {
        await this.codexClient.turnInterrupt({
            threadId: params.threadId,
            turnId: params.turnId
        });
    }

    private async fetchAvailableModels(): Promise<Model[]> {
        const models: Model[] = [];
        let cursor: string | null = null;

        do {
            const response = await this.codexClient.listModels({cursor, limit: null});
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
    models: Model[],
    agentMode: AgentMode,
}

function buildPromptItems(prompt: acp.ContentBlock[]): UserInput[] {
    return prompt.map((block): UserInput | null => {
        switch (block.type) {
            case "text":
                return {type: "text", text: block.text};
            case "image": {
                const url = block.uri ?? `data:${block.mimeType};base64,${block.data}`;
                return {type: "image", url};
            }
            case "resource_link":
                return {type: "text", text: formatUriAsLink(block.name, block.uri)};
            case "resource": {
                const resource = block.resource as EmbeddedResourceResource;
                if ("text" in resource) {
                    const link = formatUriAsLink(null, resource.uri);
                    const context = `<context ref="${resource.uri}">\n${resource.text}\n</context>`;
                    return {type: "text", text: `${link}\n${context}`};
                }
                return null;
            }
            case "audio":
                return null;
        }
    }).filter((block): block is UserInput => block !== null);
}

function formatUriAsLink(name: string | null | undefined, uri: string): string {
    if (name && name.length > 0) {
        return `[@${name}](${uri})`;
    }
    if (uri.startsWith("file://")) {
        const path = uri.replace("file://", "");
        const fileName = path.split("/").pop() ?? path;
        return `[@${fileName}](${uri})`;
    }
    return uri;
}
