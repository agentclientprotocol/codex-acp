import {isCodexAuthRequest} from "./CodexAuthMethod";
import type {EmbeddedResourceResource} from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import {type McpServer, RequestError} from "@agentclientprotocol/sdk";
import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
    McpStartupResult,
} from "./CodexAppServerClient";
import open from "open";
import type {Disposable} from "vscode-jsonrpc";
import type {
    ClientInfo,
    ReasoningEffort,
    ServiceTier,
    ServerNotification
} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import path from "node:path";
import {logger} from "./Logger";
import {sanitizeMcpServerName} from "./McpServerName";
import type {
    AccountLoginCompletedNotification,
    AccountUpdatedNotification,
    GetAccountResponse,
    ListMcpServerStatusResponse,
    Model,
    ReviewTarget,
    SkillsListParams,
    SkillsListResponse,
    Thread,
    ThreadSourceKind,
    TurnCompletedNotification,
    UserInput,
} from "./app-server/v2";
import packageJson from "../package.json";
import type {AuthenticationStatusResponse} from "./AcpExtensions";

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
    private readonly sessionNotificationQueues = new Map<string, Promise<void>>();


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
                const providerName = typeof gatewaySettings.providerName === "string" && gatewaySettings.providerName.trim().length > 0
                    ? gatewaySettings.providerName
                    : "User-provided gateway";
                const headers: Record<string, string> = {
                    "X-Client-Feature-ID": "codex",
                    ...gatewaySettings.headers
                };

                this.gatewayConfig = {
                    modelProvider: "custom-gateway",
                    config: {
                        name: providerName,
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
            case "amazonBedrock":
                return {
                    type: "gateway",
                    name: "amazonBedrock",
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

    async logout(): Promise<void> {
        const accountUpdatedPromise = this.awaitNextAccountUpdated();
        await this.codexClient.accountLogout();
        await accountUpdatedPromise;
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

    async resumeSession(request: acp.ResumeSessionRequest, onSubscribed?: () => void): Promise<SessionMetadata> {
        await this.refreshSkills(request.cwd, request._meta);

        const response = await this.codexClient.threadResume({
            config: await this.createSessionConfig(request.cwd, request.mcpServers ?? []),
            cwd: request.cwd,
            modelProvider: this.getResumeModelProvider(),
            threadId: request.sessionId,
        });
        onSubscribed?.();
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
            currentServiceTier: response.serviceTier as ServiceTier ?? null,
        }
    }

    async loadSession(request: acp.LoadSessionRequest, onSubscribed?: () => void): Promise<SessionMetadataWithThread> {
        const response = await this.codexClient.threadResume({
            config: await this.createSessionConfig(request.cwd, request.mcpServers ?? []),
            cwd: request.cwd,
            modelProvider: this.getResumeModelProvider(),
            threadId: request.sessionId,
        });
        onSubscribed?.();
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
            currentServiceTier: response.serviceTier as ServiceTier ?? null,
            thread: response.thread,
        };
    }

    async newSession(request: acp.NewSessionRequest): Promise<SessionMetadata> {
        await this.refreshSkills(request.cwd, request._meta);

        const response = await this.codexClient.threadStart({
            config: await this.createSessionConfig(request.cwd, request.mcpServers),
            modelProvider: this.getModelProvider(),
            cwd: request.cwd,
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
            currentServiceTier: response.serviceTier as ServiceTier ?? null,
        };
    }

    async closeSession(sessionId: string): Promise<void> {
        try {
            await this.codexClient.threadUnsubscribe({threadId: sessionId});
        } finally {
            this.codexClient.clearThreadHandlers(sessionId);
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.codexClient.threadArchive({threadId: sessionId});
    }

    async runReview(
        sessionId: string,
        target: ReviewTarget,
        onTurnStarted?: (turnId: string) => void,
    ): Promise<TurnCompletedNotification> {
        return await this.codexClient.runReview({
            threadId: sessionId,
            target,
            delivery: "inline",
        }, onTurnStarted);
    }

    async runCompact(sessionId: string): Promise<void> {
        await this.codexClient.runCompact({threadId: sessionId});
    }

    async awaitMcpServerStartup(serverNames: Array<string>, afterVersion: number): Promise<McpStartupResult> {
        return await this.codexClient.awaitMcpServerStartup(serverNames, afterVersion);
    }

    getMcpServerStartupVersion(): number {
        return this.codexClient.getMcpServerStartupVersion();
    }

    private async createSessionConfig(projectPath: string, mcpServers: Array<McpServer>): Promise<JsonObject> {
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

        // Deduplicates new servers against existing config to prevent Codex from deep-merging
        // incompatible field types (e.g., mixing url and stdio schemas).
        const existingNames = await this.getConfigMcpServerNames(projectPath);
        const requestedServers = mcpServers.map(mcp => ({
            name: sanitizeMcpServerName(mcp.name),
            server: mcp,
        }));
        const uniqueServers = requestedServers.filter(mcp => !existingNames.has(mcp.name));
        if (uniqueServers.length === 0) {
            return mergedConfig;
        }

        return {
            ...mergedConfig,
            "mcp_servers": Object.fromEntries(uniqueServers.map(mcp => [mcp.name, this.createMcpSeverConfig(mcp.server)])),
        };
    }

    private async getConfigMcpServerNames(projectPath: string): Promise<Set<string>> {
        const response = await this.codexClient.configRead({ includeLayers: true, cwd: projectPath });
        const mcpServers = response?.config?.["mcp_servers"];
        if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
            return new Set();
        }
        return new Set(Object.keys(mcpServers));
    }

    getModelProvider(): string | null {
        return this.gatewayConfig?.modelProvider ?? this.modelProvider;
    }

    private getResumeModelProvider(): string {
        // Passing `null` forces codex to use the persisted provider for resumed session instead of default one
        // Explicit fallback to "openai" fixes error `Model provider not found` at least for ChatGPT authentication
        return this.getModelProvider() ?? "openai";
    }

    private async refreshSkills(cwd: string, meta?: Record<string, unknown> | null): Promise<void> {
        if (!cwd) {
            return;
        }

        const additionalRoots = readAdditionalRoots(meta).map(root => path.join(root, ".agents", "skills"));
        if (additionalRoots.length > 0) {
            await this.codexClient.skillsExtraRootsSet({ extraRoots: additionalRoots });
        }
        await this.codexClient.listSkills({
            cwds: [cwd],
            forceReload: true,
        });
    }

    /**
     * Create a codex config entry for MCP server
     */
    private createMcpSeverConfig(mcpServer: McpServer): JsonObject {
        if ("type" in mcpServer) {
            switch (mcpServer.type) {
                case "acp":
                    throw RequestError.invalidRequest("Codex doesn't support MCP ACP transport protocol")
                case "sse":
                    throw RequestError.invalidRequest("Codex doesn't support MCP SSE transport protocol")
                case "http":
                    return {
                        "url": mcpServer.url,
                        "http_headers": Object.fromEntries(mcpServer.headers.map(h => [h.name, h.value])),
                    }
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
        eventHandler: (result: ServerNotification) => void | Promise<void>,
        approvalHandler: ApprovalHandler,
        elicitationHandler: ElicitationHandler
    ) {
        this.codexClient.onServerNotification(sessionId, (event) => {
            this.enqueueSessionNotification(sessionId, () => eventHandler(event));
        });
        this.codexClient.onApprovalRequest(sessionId, {
            handleCommandExecution: async (params) => {
                await this.waitForSessionNotifications(sessionId);
                return await approvalHandler.handleCommandExecution(params);
            },
            handleFileChange: async (params) => {
                await this.waitForSessionNotifications(sessionId);
                return await approvalHandler.handleFileChange(params);
            },
        });
        this.codexClient.onElicitationRequest(sessionId, {
            handleElicitation: async (params) => {
                await this.waitForSessionNotifications(sessionId);
                return await elicitationHandler.handleElicitation(params);
            },
        });
    }

    async waitForSessionNotifications(sessionId: string): Promise<void> {
        while (true) {
            const queue = this.sessionNotificationQueues.get(sessionId);
            if (!queue) return;
            await queue;
        }
    }

    private enqueueSessionNotification(sessionId: string, operation: () => void | Promise<void>): void {
        const run = async () => {
            try {
                await operation();
            } catch (error) {
                logger.error("Error handling Codex session notification", error);
            }
        };

        const previous = this.sessionNotificationQueues.get(sessionId);
        const next = previous ? previous.then(run, run) : run();
        this.sessionNotificationQueues.set(sessionId, next);
        void next.finally(() => {
            if (this.sessionNotificationQueues.get(sessionId) === next) {
                this.sessionNotificationQueues.delete(sessionId);
            }
        });
    }

    async sendPrompt(
        request: acp.PromptRequest,
        agentMode: AgentMode,
        modelId: ModelId,
        serviceTier: ServiceTier | null,
        disableSummary: boolean,
        cwd: string,
        onTurnStarted?: (turnId: string) => void,
        shouldCancel?: () => boolean,
    ): Promise<TurnCompletedNotification | null> {
        const input = buildPromptItems(request.prompt);
        const effort = modelId.effort as ReasoningEffort | null; //TODO remove unsafe conversion

        await this.refreshSkills(cwd, request._meta);
        if (shouldCancel?.()) {
            return null;
        }
        return await this.codexClient.runTurn({
            threadId: request.sessionId,
            input: input,
            approvalPolicy: agentMode.approvalPolicy,
            sandboxPolicy: agentMode.sandboxPolicy,
            summary: disableSummary ? "none" : "auto",
            effort: effort,
            model: modelId.model,
            serviceTier: serviceTier,
        }, onTurnStarted);
    }

    resolveTurnInterrupted(params: { threadId: string, turnId: string }): void {
        this.codexClient.resolveTurnInterrupted(params.threadId, params.turnId);
    }

    markTurnStale(params: { threadId: string, turnId: string }): void {
        this.codexClient.markTurnStale(params.threadId, params.turnId);
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

    async listMcpServers(): Promise<ListMcpServerStatusResponse> {
        return this.codexClient.listMcpServerStatus({});
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
            modelProviders: modelProviders,
            sourceKinds: sourceKinds,
        });

        if (listResponse.data.length === 0) {
            const diagnostics = await this.runSessionListDiagnostics();
            logger.log("Session list diagnostics", diagnostics);
        }

        let sessions = listResponse.data.map((thread) => ({
            sessionId: thread.id,
            cwd: thread.cwd,
            title: (thread.name ?? thread.preview) || null,
            updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
        }));
        if (requestedCwd) {
            const filtered = listResponse.data
                .filter(filterByCwd)
                .map((thread) => ({
                    sessionId: thread.id,
                    cwd: thread.cwd,
                    title: (thread.name ?? thread.preview) || null,
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
            this.codexClient.threadList({}),
            this.codexClient.threadList({archived: true}),
            this.codexClient.threadList({modelProviders: ["custom-gateway"]}),
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
    currentServiceTier?: ServiceTier | null,
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
                if (isImageMimeType(resource.mimeType)) {
                    return {type: "image", url: `data:${resource.mimeType};base64,${resource.blob}`};
                }
                const link = formatUriAsLink(null, resource.uri);
                const mimeType = resource.mimeType ?? "application/octet-stream";
                const context = `<context ref="${resource.uri}" mimeType="${mimeType}" encoding="base64">\n${resource.blob}\n</context>`;
                return {type: "text", text: `${link}\n${context}`, text_elements: []};
            }
            case "audio":
                return null;
        }
    }).filter((block): block is UserInput => block !== null);
}

function isImageMimeType(mimeType: string | null | undefined): mimeType is string {
    return mimeType?.startsWith("image/") ?? false;
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
