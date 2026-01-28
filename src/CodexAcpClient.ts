import {isCodexAuthRequest} from "./CodexAuthMethod";
import * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {ApprovalHandler, CodexAppServerClient} from "./CodexAppServerClient";
import open from "open";
import type {
    ClientInfo,
    ReasoningEffort,
    ServerNotification,
    SetDefaultModelParams,
    SetDefaultModelResponse
} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import type {EmbeddedResourceResource} from "@agentclientprotocol/sdk";
import type {
    GetAccountResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    Model,
    SkillsListParams,
    SkillsListResponse,
    TurnCompletedNotification,
    UserInput,
} from "./app-server/v2";

/**
 * API for accessing the Codex App Server using ACP requests.
 * Converts ACP requests into corresponding app-server operations.
 */
export class CodexAcpClient {

    private readonly codexClient: CodexAppServerClient;
    private readonly config: JsonObject;
    private readonly modelProvider: string | null;
    private gatewayConfig: GatewayConfig | null;


    constructor(codexClient: CodexAppServerClient, codexConfig?: JsonObject, modelProvider?: string) {
        this.codexClient = codexClient;
        this.config = codexConfig ?? {};
        this.modelProvider = modelProvider ?? null;
        this.gatewayConfig = null;
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
                if (!authRequest._meta || !authRequest._meta["api-key"]) throw RequestError.invalidRequest();
                await this.codexClient.accountLogin({
                    type: "apiKey",
                    apiKey: authRequest._meta["api-key"].apiKey
                });
                break;
            case "chat-gpt":
                const loginResponse = await this.codexClient.accountLogin({type: "chatgpt"});
                if (loginResponse.type == "chatgpt") {
                    await open(loginResponse.authUrl);
                }
                break;
            case "gateway":
                if (!authRequest._meta) throw RequestError.invalidRequest();

                const gatewaySettings = authRequest._meta["gateway"]
                if (!gatewaySettings) throw RequestError.invalidRequest();

                const baseUrl = gatewaySettings.baseUrl;
                const headers: Record<string, string> = {
                    "X-Client-Feature-ID": "codex",
                    ...gatewaySettings.headers
                };

                this.gatewayConfig = {
                    modelProvider: "custom-gateway",
                    config: {
                        name: "User-provided gateway",
                        base_url: baseUrl,
                        http_headers: headers,
                        wire_api: "responses"
                    }
                }

                // Early return: model provider information will be sent to Codex later during the session creation
                return true;

        }

        // Reset the gateway config to null if another authentication method was used
        this.gatewayConfig = null;

        const result = await this.codexClient.awaitLoginCompleted()
        return result.success;
    }

    async logout(): Promise<void> {
        await this.codexClient.accountLogout();
        await this.codexClient.awaitAccountUpdated();
    }

    async authRequired(): Promise<Boolean> {
        if (this.gatewayConfig != null) {
            // The authentication is already in progress:
            // the gateway config is set during the authentication request processing.
            // We assume that custom model providers will handle authentication themselves,
            // so Codex will not need to require it.
            return false;
        }

        const response = await this.codexClient.accountRead({refreshToken: false})
        return response.requiresOpenaiAuth && !response.account;
    }

    async getAccount(): Promise<GetAccountResponse> {
        return this.codexClient.accountRead({refreshToken: false});
    }

    async resumeSession(request: acp.ResumeSessionRequest): Promise<SessionMetadata> {
        const sessionModelProvider = this.gatewayConfig?.modelProvider ?? this.modelProvider;
        const sessionConfig = mergeGatewayConfig(this.config, this.gatewayConfig)
        const response = await this.codexClient.threadResume({
            approvalPolicy: null,
            sandbox: null,
            baseInstructions: null,
            config: sessionConfig,
            cwd: request.cwd,
            developerInstructions: null,
            history: null,
            model: null,
            modelProvider: sessionModelProvider,
            path: null,
            threadId: request.sessionId,
        });
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
            agentMode: AgentMode.getInitialAgentMode(),
        }
    }

    async newSession(request: acp.NewSessionRequest): Promise<SessionMetadata> {
        const sessionModelProvider = this.gatewayConfig?.modelProvider ?? this.modelProvider;
        const sessionConfig = mergeGatewayConfig(this.config, this.gatewayConfig)
        const response = await this.codexClient.threadStart({
            config: sessionConfig,
            modelProvider: sessionModelProvider,
            model: null,
            cwd: request.cwd,
            approvalPolicy: null,
            sandbox: null,
            baseInstructions: null,
            developerInstructions: null,
            experimentalRawEvents: false
        });

        const codexModels = await this.fetchAvailableModels();
        if (codexModels.length === 0) {
            throw new Error("Codex did not return any models");
        }
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: response.thread.id,
            currentModelId: currentModelId,
            models: codexModels,
            agentMode: AgentMode.getInitialAgentMode(),
        };
    }

    /**
     * Resolves a ModelId using the provided ID and reasoning effort.
     * Falls back to model defaults if parameters are missing or unsupported.
     */
    createModelId(availableModels: Model[], modelId: string | null, reasoningEffort: ReasoningEffort | null): ModelId {
        const selectedModel =
            availableModels.find(m => m.id === modelId) ??
            availableModels.find(m => m.isDefault);

        if (!selectedModel) {
            throw new Error(`Model selection failed: No model found for ID "${modelId}" and no default model is defined.`);
        }

        return ModelId.create(selectedModel.id, reasoningEffort ?? selectedModel.defaultReasoningEffort);
    }

    async subscribeToSessionEvents(
        sessionId: string,
        eventHandler: (result: ServerNotification) => void,
        approvalHandler: ApprovalHandler
    ) {
        this.codexClient.onServerNotification(sessionId, eventHandler);
        this.codexClient.onApprovalRequest(sessionId, approvalHandler);
    }

    async sendPrompt(
        request: acp.PromptRequest,
        agentMode: AgentMode,
        modelId: ModelId,
        disableSummary: boolean,
    ): Promise<TurnCompletedNotification> {
        const input = buildPromptItems(request.prompt);
        const effort = modelId.effort as ReasoningEffort | null; //TODO remove unsafe conversion
        await this.codexClient.turnStart({
            outputSchema: null,
            threadId: request.sessionId,
            input: input,
            approvalPolicy: agentMode.approvalPolicy,
            sandboxPolicy: agentMode.sandboxPolicy,
            summary: disableSummary ? "none" : null,
            cwd: null,
            effort: effort,
            model: modelId.model,
        });

        // Wait for turn completion
        // If turnInterrupt() was called, Codex will send turn/completed event with status "interrupted"
        return await this.codexClient.awaitTurnCompleted();
    }

    async setModel(params: SetDefaultModelParams): Promise<SetDefaultModelResponse> {
        return this.codexClient.setModelRequest(params);
    }

    async listSkills(params?: SkillsListParams): Promise<SkillsListResponse> {
        return this.codexClient.listSkills(params ?? {});
    }

    async listMcpServers(params: ListMcpServerStatusParams = { cursor: null, limit: null }): Promise<ListMcpServerStatusResponse> {
        return this.codexClient.listMcpServerStatus(params);
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
                return {type: "text", text: block.text, text_elements: []};
            case "image": {
                const url = block.uri ?? `data:${block.mimeType};base64,${block.data}`;
                return {type: "image", url};
            }
            case "resource_link":
                return {type: "text", text: formatUriAsLink(block.name, block.uri), text_elements: []};
            case "resource": {
                const resource = block.resource as EmbeddedResourceResource;
                if ("text" in resource) {
                    const link = formatUriAsLink(null, resource.uri);
                    const context = `<context ref="${resource.uri}">\n${resource.text}\n</context>`;
                    return {type: "text", text: `${link}\n${context}`, text_elements: []};
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

interface GatewayConfig {
    modelProvider: string;
    config: {
        name: string,
        base_url: string,
        http_headers: Record<string, string>,
        wire_api: "responses"
    }
}

function mergeGatewayConfig(config: JsonObject, gatewayConfig: GatewayConfig | null): JsonObject {
    if (gatewayConfig !== null) {
        const newConfig = {...config};
        if (!newConfig["model_providers"] || typeof newConfig["model_providers"] !== 'object') {
            newConfig["model_providers"] = {};
        } else {
            newConfig["model_providers"] = {...newConfig["model_providers"] as JsonObject};
        }

        newConfig["model_providers"][gatewayConfig.modelProvider] = gatewayConfig.config;
        return newConfig;
    } else {
        return config;
    }
}
