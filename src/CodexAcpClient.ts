import {isCodexAuthRequest} from "./CodexAuthMethod";
import type {EmbeddedResourceResource} from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import {type McpServer, RequestError} from "@agentclientprotocol/sdk";
import type {ApprovalHandler, CodexAppServerClient} from "./CodexAppServerClient";
import open from "open";
import type {Disposable} from "vscode-jsonrpc";
import type {
    ClientInfo,
    McpStartupCompleteEvent,
    ReasoningEffort,
    ServerNotification
} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import path from "node:path";
import {logger} from "./Logger";
import type {
    AccountLoginCompletedNotification,
    AccountUpdatedNotification,
    GetAccountResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    Model,
    SkillsListParams,
    SkillsListResponse,
    Thread,
    ThreadSourceKind,
    TurnCompletedNotification,
    UserInput,
} from "./app-server/v2";
import packageJson from "../package.json";
import type {AuthenticationLogoutResponse, AuthenticationStatusResponse} from "./AcpExtensions";

/**
 * API for accessing the Codex App Server using ACP requests.
 * Converts ACP requests into corresponding app-server operations.
 */
export class CodexAcpClient {
    private readonly codexClient: CodexAppServerClient;
    private readonly config: JsonObject;
    private readonly modelProvider: string | null;
    private gatewayConfig: GatewayConfig | null;
    private pendingLoginCompleted: Promise<AccountLoginCompletedNotification> | null = null;
    private pendingAccountUpdated: Promise<AccountUpdatedNotification> | null = null;


    constructor(codexClient: CodexAppServerClient, codexConfig?: JsonObject, modelProvider?: string) {
        this.codexClient = codexClient;
        this.config = codexConfig ?? {};
        this.modelProvider = modelProvider ?? null;
        this.gatewayConfig = null;
    }

    private readonly defaultClientInfo: ClientInfo = {
        name: `${packageJson.name}`, title: "Codex ACP", version: `${packageJson.version}`
    };

    async initialize(request: acp.InitializeRequest): Promise<void> {
        await this.codexClient.initialize({
            capabilities: null,
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
            case "api-key": {
                if (!authRequest._meta || !authRequest._meta["api-key"]) throw RequestError.invalidRequest();
                const loginCompletedPromise = this.awaitNextLoginCompleted();
                await this.codexClient.accountLogin({
                    type: "apiKey",
                    apiKey: authRequest._meta["api-key"].apiKey
                });
                this.gatewayConfig = null;
                const result = await loginCompletedPromise;
                return result.success;
            }
            case "chat-gpt": {
                const loginCompletedPromise = this.awaitNextLoginCompleted();
                const loginResponse = await this.codexClient.accountLogin({type: "chatgpt"});
                if (loginResponse.type == "chatgpt") {
                    await open(loginResponse.authUrl);
                }
                this.gatewayConfig = null;
                const result = await loginCompletedPromise;
                return result.success;
            }
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
        return false;
    }


    async getAuthenticationStatus(): Promise<AuthenticationStatusResponse> {
        const modelProvider = await this.getCurrentModelProvider();
        if (modelProvider) {
            return {
                type: "gateway",
                name: modelProvider,
            };
        }
        const account = (await this.getAccount()).account;
        if (account === null) {
            return {
                type: "unauthenticated",
            };
        }
        switch (account.type) {
            case "apiKey":
                return {
                    type: "api-key",
                };
            case "chatgpt":
                return {
                    type: "chat-gpt",
                    email: account.email,
                };
        }
    }

    async getCurrentModelProvider(): Promise<string | null> {
        const sessionModelProvider = this.getModelProvider();
        if (sessionModelProvider !== null) {
            return sessionModelProvider;
        }
        const settingsModelProvider = await this.codexClient.configRead({includeLayers: false});
        return settingsModelProvider.config.model_provider;
    }

    async logout(): Promise<AuthenticationLogoutResponse> {
        const accountUpdatedPromise = this.awaitNextAccountUpdated();
        await this.codexClient.accountLogout();
        await accountUpdatedPromise;
        return {};
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
        await this.refreshSkills(request.cwd, request._meta);

        const response = await this.codexClient.threadResume({
            approvalPolicy: null,
            sandbox: null,
            baseInstructions: null,
            config: this.createSessionConfig(request.cwd, request.mcpServers ?? []),
            cwd: request.cwd,
            developerInstructions: null,
            history: null,
            model: null,
            modelProvider: this.getModelProvider(),
            path: null,
            personality: null,
            persistExtendedHistory: false,
            threadId: request.sessionId,
        });
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
        }
    }

    async loadSession(request: acp.LoadSessionRequest): Promise<SessionMetadataWithThread> {
        const response = await this.codexClient.threadResume({
            approvalPolicy: null,
            sandbox: null,
            baseInstructions: null,
            config: this.createSessionConfig(request.cwd, request.mcpServers ?? []),
            cwd: request.cwd,
            developerInstructions: null,
            history: null,
            model: null,
            modelProvider: this.getModelProvider(),
            path: null,
            personality: null,
            persistExtendedHistory: false,
            threadId: request.sessionId,
        });
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
            thread: response.thread,
        };
    }

    async newSession(request: acp.NewSessionRequest): Promise<SessionMetadata> {
        await this.refreshSkills(request.cwd, request._meta);

        const response = await this.codexClient.threadStart({
            config: this.createSessionConfig(request.cwd, request.mcpServers),
            modelProvider: this.getModelProvider(),
            model: null,
            cwd: request.cwd,
            approvalPolicy: null,
            sandbox: null,
            baseInstructions: null,
            developerInstructions: null,
            personality: null,
            ephemeral: null,
            experimentalRawEvents: false,
            persistExtendedHistory: false
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
        };
    }

    async awaitMcpStartup(mcpStartupVersion: number): Promise<Array<string>> {
        const startup = await this.codexClient.awaitMcpStartup(mcpStartupVersion);
        return startup.ready;
    }

    async awaitMcpStartupResult(mcpStartupVersion: number): Promise<McpStartupCompleteEvent> {
        return await this.codexClient.awaitMcpStartup(mcpStartupVersion);
    }

    getMcpStartupCompleteVersion(): number {
        return this.codexClient.getMcpStartupCompleteVersion();
    }

    private createSessionConfig(projectPath: string, mcpServers: Array<McpServer>): JsonObject {
        const mergedConfig = {
            ...mergeGatewayConfig(this.config, this.gatewayConfig),
            projects: {
                [projectPath]: {
                    trust_level: "trusted",
                }
            },
        };
        if (mcpServers.length === 0) {
            return mergedConfig;
        }
        return {
            ...mergedConfig,
            "mcp_servers": Object.fromEntries(mcpServers.map(mcp => [mcp.name, this.createMcpSeverConfig(mcp)]))
        }
    }

    private getModelProvider(): string | null {
        return this.gatewayConfig?.modelProvider ?? this.modelProvider;
    }

    private async refreshSkills(cwd: string, meta?: Record<string, unknown> | null): Promise<void> {
        if (!cwd) {
            return;
        }
        const additionalRoots = readAdditionalRoots(meta);
        await this.codexClient.listSkills({
            cwds: [cwd],
            forceReload: true,
            perCwdExtraUserRoots: [{
                cwd: cwd,
                extraUserRoots: additionalRoots
            }]
        });
    }

    /**
     * Create a codex config entry for MCP server
     */
    private createMcpSeverConfig(mcpServer: McpServer): JsonObject {
        if ("type" in mcpServer) {
            if (mcpServer.type == "sse") {
                throw RequestError.invalidRequest("Codex doesn't support MCP SSE transport protocol")
            }
            return {
                "url": mcpServer.url,
                "http_headers": Object.fromEntries(mcpServer.headers.map(h => [h.name, h.value])),
            }
        }
        return {
            "command": mcpServer.command,
            "args": mcpServer.args,
            "env": Object.fromEntries(mcpServer.env.map(env => [env.name, env.value])),
        }
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
        cwd: string,
    ): Promise<TurnCompletedNotification> {
        const input = buildPromptItems(request.prompt);
        const effort = modelId.effort as ReasoningEffort | null; //TODO remove unsafe conversion

        await this.refreshSkills(cwd, request._meta);
        await this.codexClient.turnStart({
            outputSchema: null,
            threadId: request.sessionId,
            input: input,
            approvalPolicy: agentMode.approvalPolicy,
            sandboxPolicy: agentMode.sandboxPolicy,
            summary: disableSummary ? "none" : null,
            personality: null,
            collaborationMode: null,
            cwd: null,
            effort: effort,
            model: modelId.model,
        });

        // Wait for turn completion
        // If turnInterrupt() was called, Codex will send turn/completed event with status "interrupted"
        return await this.codexClient.awaitTurnCompleted();
    }

    async listSkills(params?: SkillsListParams): Promise<SkillsListResponse> {
        return this.codexClient.listSkills(params ?? {});
    }

    private async awaitNextLoginCompleted(): Promise<AccountLoginCompletedNotification> {
        if (this.pendingLoginCompleted !== null) {
            return await this.pendingLoginCompleted;
        }
        this.pendingLoginCompleted = this.awaitSingleNotification(
            "account/login/completed",
            (event: AccountLoginCompletedNotification) => event,
        );
        try {
            return await this.pendingLoginCompleted;
        } finally {
            this.pendingLoginCompleted = null;
        }
    }

    private async awaitNextAccountUpdated(): Promise<AccountUpdatedNotification> {
        if (this.pendingAccountUpdated !== null) {
            return await this.pendingAccountUpdated;
        }
        this.pendingAccountUpdated = this.awaitSingleNotification(
            "account/updated",
            (event: AccountUpdatedNotification) => event,
        );
        try {
            return await this.pendingAccountUpdated;
        } finally {
            this.pendingAccountUpdated = null;
        }
    }

    private async awaitSingleNotification<T>(
        method: "account/login/completed" | "account/updated",
        mapEvent: (event: T) => T,
    ): Promise<T> {
        return await new Promise((resolve) => {
            let disposable: Disposable | undefined;
            disposable = this.codexClient.connection.onNotification(method, (event: T) => {
                disposable?.dispose();
                resolve(mapEvent(event));
            });
        });
    }

    async listMcpServers(params: ListMcpServerStatusParams = { cursor: null, limit: null }): Promise<ListMcpServerStatusResponse> {
        return this.codexClient.listMcpServerStatus(params);
    }

    async listSessions(request: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        const sourceKinds: ThreadSourceKind[] = [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
        ];
        const requestedCwd = request.cwd?.trim() ?? null;
        const filterByCwd = (thread: Thread): boolean => {
            if (!requestedCwd) return true;
            if (path.isAbsolute(requestedCwd)) {
                return thread.cwd === requestedCwd;
            }
            const requestedBase = path.basename(requestedCwd);
            return path.basename(thread.cwd) === requestedBase;
        };

        const preferredProvider = this.getModelProvider();
        const modelProviders = preferredProvider ? [preferredProvider] : [];
        const listResponse = await this.codexClient.threadList({
            cursor: request.cursor ?? null,
            limit: null,
            sortKey: null,
            modelProviders: modelProviders,
            sourceKinds: sourceKinds,
            archived: null,
        });

        if (listResponse.data.length === 0) {
            const diagnostics = await this.runSessionListDiagnostics();
            logger.log("Session list diagnostics", diagnostics);
        }

        let sessions = listResponse.data.map((thread) => ({
            sessionId: thread.id,
            cwd: thread.cwd,
            title: thread.preview || null,
            updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
        }));
        if (requestedCwd) {
            const filtered = listResponse.data
                .filter(filterByCwd)
                .map((thread) => ({
                    sessionId: thread.id,
                    cwd: thread.cwd,
                    title: thread.preview || null,
                    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
                }));
            if (filtered.length > 0 || path.isAbsolute(requestedCwd)) {
                sessions = filtered;
            } else {
                logger.log("Ignoring non-absolute cwd filter for session/list", {cwd: requestedCwd});
            }
        }

        return {
            sessions,
            nextCursor: listResponse.nextCursor ?? null,
        };
    }

    async turnInterrupt(params: { threadId: string, turnId: string }): Promise<void> {
        await this.codexClient.turnInterrupt({
            threadId: params.threadId,
            turnId: params.turnId
        });
    }

    async fetchAvailableModels(): Promise<Model[]> {
        const models: Model[] = [];
        let cursor: string | null = null;

        do {
            const response = await this.codexClient.listModels({cursor, limit: null});
            models.push(...response.data);
            cursor = response.nextCursor;
        } while (cursor);

        return models;
    }

    private async runSessionListDiagnostics(): Promise<Record<string, unknown>> {
        const [allProviders, archivedAllProviders, customGateway] = await Promise.all([
            this.codexClient.threadList({
                cursor: null,
                limit: null,
                sortKey: null,
                modelProviders: [],
                sourceKinds: null,
                archived: null,
            }),
            this.codexClient.threadList({
                cursor: null,
                limit: null,
                sortKey: null,
                modelProviders: [],
                sourceKinds: null,
                archived: true,
            }),
            this.codexClient.threadList({
                cursor: null,
                limit: null,
                sortKey: null,
                modelProviders: ["custom-gateway"],
                sourceKinds: null,
                archived: null,
            }),
        ]);

        return {
            allProviders: {
                count: allProviders.data.length,
                nextCursor: allProviders.nextCursor ?? null,
            },
            archivedAllProviders: {
                count: archivedAllProviders.data.length,
                nextCursor: archivedAllProviders.nextCursor ?? null,
            },
            customGateway: {
                count: customGateway.data.length,
                nextCursor: customGateway.nextCursor ?? null,
            },
        };
    }

}

export type JsonObject = { [key in string]?: JsonValue }

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
}

export type SessionMetadataWithThread = SessionMetadata & {
    thread: Thread,
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

function readAdditionalRoots(meta: Record<string, unknown> | null | undefined): string[] {
    const rawRoots = meta?.["additionalRoots"];
    if (!Array.isArray(rawRoots)) {
        return [];
    }

    return Array.from(new Set(rawRoots
        .filter((value): value is string => typeof value === "string")
        .map(value => value.trim())
        .filter(value => value.length > 0)));
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
