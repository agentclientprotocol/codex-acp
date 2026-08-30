import {
    type ApiKeyAuthRequest,
    CODEX_API_KEY_ENV_VAR,
    GatewayAuthMethod,
    type GatewayAuthRequest,
    isCodexAuthRequest,
    OPENAI_API_KEY_ENV_VAR,
} from "./CodexAuthMethod";
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
    ServerNotification
} from "./app-server";
import type {ServiceTier} from "./app-server/ServiceTier";
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
    SandboxPolicy,
    Thread,
    ThreadGoal,
    ThreadGoalStatus,
    ThreadSourceKind,
    TurnCompletedNotification,
    TurnSteerResponse,
    UserInput,
} from "./app-server/v2";
import packageJson from "../package.json";
import type {AuthenticationStatusResponse} from "./AcpExtensions";
import {createCodexCollaborationMode} from "./CollaborationModeConfig";
import type {ModeKind} from "./app-server/ModeKind";
import {arePathBasenamesEqual, arePathsEqual, isAbsolutePathLike} from "./PathUtils";
import {
    AGENT_FILE_CHANGE_REPORT_DEVELOPER_INSTRUCTIONS,
    AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA,
    AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS,
    type AgentFileChangeReport,
    AgentFileChangeReportError,
    type AgentFileChangeWorkspace,
    createAgentFileChangeReportPrompt,
    createReportedAgentFileChangeReport,
    createUnavailableAgentFileChangeReport,
} from "./AgentFileChangeReport";
import {CodexSubagentSubscriptions} from "./subagents/CodexSubagentSubscriptions";
import {forkSession as runForkSession} from "./SessionFork";
import type {SessionMetadata, SessionMetadataWithThread} from "./SessionMetadata";
import {
    executeGuardedTtyExec,
    type GuardedTtyExecOptions,
} from "./GuardedTtyExec";
import type {KandevGuardedTtyExecReceipt} from "./AcpExtensions";
export type {SessionMetadata, SessionMetadataWithThread} from "./SessionMetadata";

/**
 * Well-known provider id for the client-configurable custom LLM gateway.
 * This is the only provider exposed through the ACP `providers/*` methods and
 * the `gateway` auth method; it maps to a Codex `model_providers` entry.
 */
export const CUSTOM_GATEWAY_PROVIDER_ID = "custom-gateway";
export const OPENAI_PROVIDER_ID = "openai";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The url-mode variant of the ACP `elicitation/create` request params.
 */
export type CreateUrlElicitationRequest = Extract<acp.CreateElicitationRequest, {mode: "url"}>;

/**
 * The fields of a URL elicitation this layer can fill in; the ACP server layer
 * supplies the rest (`mode`, `requestId`) when sending `elicitation/create`.
 */
export type UrlElicitationRequest = Omit<CreateUrlElicitationRequest, "mode" | "requestId">;

export interface UrlElicitationRequester {
    elicitUrl(request: UrlElicitationRequest): Promise<acp.CreateElicitationResponse>;
    completeElicitation(): Promise<void>;
}

/**
 * ACP `LlmProtocol` values Codex can route through the custom gateway, mapped to
 * the Codex `wire_api`. Codex only supports the OpenAI Responses wire API here.
 */
const SUPPORTED_GATEWAY_PROTOCOLS: Record<acp.LlmProtocol, WireApi> = {
    openai: "responses",
};

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
    private readonly subagents: CodexSubagentSubscriptions;
    private skillExtraRoots: string[] = [];
    private configPath: string | null = null;


    constructor(codexClient: CodexAppServerClient, codexConfig?: JsonObject, modelProvider?: string) {
        this.codexClient = codexClient;
        this.config = codexConfig ?? {};
        this.modelProvider = modelProvider ?? null;
        this.gatewayConfig = null;
        this.subagents = new CodexSubagentSubscriptions(codexClient);
    }

    private readonly defaultClientInfo: ClientInfo = {
        name: `${packageJson.name}`, title: "Codex ACP", version: `${packageJson.version}`
    };

    async initialize(request: acp.InitializeRequest): Promise<void> {
        const response = await this.codexClient.initialize({
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
            },
            clientInfo: {
                name: request.clientInfo?.name ?? this.defaultClientInfo.name,
                version: request.clientInfo?.version ?? this.defaultClientInfo.version,
                title: request.clientInfo?.title ?? this.defaultClientInfo.title,
            }
        });
        this.configPath = response?.codexHome ?? null;
    }

    getHomePath(): string | null {
        return this.configPath;
    }

    async guardedTtyExec(options: GuardedTtyExecOptions): Promise<KandevGuardedTtyExecReceipt> {
        return await executeGuardedTtyExec(this.codexClient, options);
    }

    async authenticate(
        authRequest: acp.AuthenticateRequest,
        urlElicitationRequester?: UrlElicitationRequester,
    ): Promise<Boolean> {
        if (!isCodexAuthRequest(authRequest)) {
            throw RequestError.invalidRequest();
        }
        this.gatewayConfig = null;
        switch (authRequest.methodId) {
            case "api-key":
                return await this.authenticateWithApiKey(authRequest);
            case "chat-gpt":
                return await this.authenticateWithChatGpt();
            case "chat-gpt-device-code":
                return await this.authenticateWithChatGptDeviceCode(urlElicitationRequester);
            case "gateway":
                return this.authenticateWithGateway(authRequest);
        }
    }

    private async authenticateWithApiKey(authRequest: ApiKeyAuthRequest): Promise<Boolean> {
        const apiKey = authRequest._meta?.["api-key"]?.apiKey ?? this.readApiKeyFromEnv();
        const loginCompletedPromise = this.awaitNextLoginCompleted();
        await this.codexClient.accountLogin({
            type: "apiKey",
            apiKey,
        });
        const result = await loginCompletedPromise;
        return result.success;
    }

    private async authenticateWithChatGpt(): Promise<Boolean> {
        const accountResponse = await this.codexClient.accountRead({refreshToken: true});
        if (accountResponse.account?.type === "chatgpt") {
            return true;
        }
        const loginCompletedPromise = this.awaitNextLoginCompleted();
        const loginResponse = await this.codexClient.accountLogin({type: "chatgpt"});
        if (loginResponse.type == "chatgpt") {
            await open(loginResponse.authUrl);
        }
        const result = await loginCompletedPromise;
        return result.success;
    }

    private async authenticateWithChatGptDeviceCode(urlElicitationRequester?: UrlElicitationRequester): Promise<Boolean> {
        const accountResponse = await this.codexClient.accountRead({refreshToken: true});
        if (accountResponse.account?.type === "chatgpt") {
            return true;
        }
        if (!urlElicitationRequester) {
            throw RequestError.invalidRequest(undefined, "Device code authentication requires URL elicitation support");
        }
        const loginCompletedPromise = this.awaitNextLoginCompleted();
        const loginResponse = await this.codexClient.accountLogin({type: "chatgptDeviceCode"});
        if (loginResponse.type !== "chatgptDeviceCode") {
            return false;
        }
        const elicitationResponsePromise = Promise.resolve(urlElicitationRequester.elicitUrl({
            url: loginResponse.verificationUrl,
            message: `Sign in to ChatGPT and enter this code: ${loginResponse.userCode}`,
            elicitationId: loginResponse.loginId,
        }));
        const first = await Promise.race([
            loginCompletedPromise.then(result => ({
                type: "loginCompleted" as const,
                result,
            })),
            elicitationResponsePromise.then(response => ({
                type: "elicitationResponse" as const,
                response,
            })),
        ]);

        if (first.type === "loginCompleted") {
            await urlElicitationRequester.completeElicitation();
            return first.result.success;
        }

        if (!acp.CreateElicitationResponse.isAccept(first.response)) {
            await this.codexClient.accountLoginCancel({loginId: loginResponse.loginId});
            return false;
        }

        const result = await loginCompletedPromise;
        await urlElicitationRequester.completeElicitation();
        return result.success;
    }

    private authenticateWithGateway(authRequest: GatewayAuthRequest): boolean {
        if (!authRequest._meta) throw RequestError.invalidRequest();

        const gatewaySettings = authRequest._meta["gateway"];
        if (!gatewaySettings) throw RequestError.invalidRequest();

        this.applyGatewayConfig({
            baseUrl: gatewaySettings.baseUrl,
            apiType: GatewayAuthMethod._meta.gateway.protocol,
            headers: gatewaySettings.headers,
            providerName: gatewaySettings.providerName,
        });

        return true;
    }

    private readApiKeyFromEnv(): string {
        for (const envVar of [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR]) {
            const value = process.env[envVar]?.trim();
            if (value) {
                return value;
            }
        }
        throw RequestError.internalError(
            {envVars: [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR]},
            `${CODEX_API_KEY_ENV_VAR} or ${OPENAI_API_KEY_ENV_VAR} is not set`
        );
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
                    email: account.email ?? "",
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
        return settingsModelProvider?.config?.model_provider ?? null;
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

    /**
     * Validates and stores custom gateway routing. Shared by the `gateway` auth
     * method and the ACP `providers/set` method. Throws `invalid_params` for an
     * unsupported protocol or a malformed base URL.
     */
    private applyGatewayConfig(params: {
        baseUrl: string;
        headers?: Record<string, string> | undefined;
        providerName?: string | undefined;
        apiType: acp.LlmProtocol;
    }): void {
        const apiType = params.apiType;
        const wireApi = SUPPORTED_GATEWAY_PROTOCOLS[apiType];
        if (!wireApi) {
            throw RequestError.invalidParams(
                {apiType},
                `Unsupported provider apiType "${apiType}"; supported: ${Object.keys(SUPPORTED_GATEWAY_PROTOCOLS).join(", ")}`,
            );
        }
        if (typeof params.baseUrl !== "string" || params.baseUrl.trim().length === 0) {
            throw RequestError.invalidParams(undefined, "baseUrl must be a non-empty string");
        }
        const providerName = typeof params.providerName === "string" && params.providerName.trim().length > 0
            ? params.providerName
            : "User-provided gateway";
        const headers: Record<string, string> = {
            "X-Client-Feature-ID": "codex",
            ...params.headers,
        };

        this.gatewayConfig = {
            modelProvider: CUSTOM_GATEWAY_PROVIDER_ID,
            config: {
                name: providerName,
                base_url: params.baseUrl,
                http_headers: headers,
                wire_api: wireApi,
            },
        };
    }

    /**
     * `providers/list`: returns Codex's OpenAI slot. With no ACP override, the
     * slot reports native OpenAI routing; headers are never exposed.
     */
    listProviders(): acp.ProviderInfo[] {
        const gatewayConfig = this.gatewayConfig;
        const current: acp.ProviderCurrentConfig = gatewayConfig
            ? {
                apiType: gatewayApiTypeFromConfig(gatewayConfig),
                baseUrl: gatewayConfig.config.base_url,
            }
            : this.getNativeProviderConfig();
        logger.log("providers/list", {
            providerId: OPENAI_PROVIDER_ID,
            overrideActive: gatewayConfig !== null,
            apiType: current.apiType,
            baseUrl: current.baseUrl,
        });
        return [
            {
                providerId: OPENAI_PROVIDER_ID,
                supported: Object.keys(SUPPORTED_GATEWAY_PROTOCOLS),
                required: false,
                current,
            },
        ];
    }

    private getNativeProviderConfig(): acp.ProviderCurrentConfig {
        const configuredProviderId = this.modelProvider ??
            (typeof this.config["model_provider"] === "string" ? this.config["model_provider"] : null);
        const configuredProviders = this.config["model_providers"];
        if (configuredProviderId && configuredProviders && typeof configuredProviders === "object" && !Array.isArray(configuredProviders)) {
            const configuredProvider = (configuredProviders as Record<string, unknown>)[configuredProviderId];
            if (configuredProvider && typeof configuredProvider === "object" && !Array.isArray(configuredProvider)) {
                const baseUrl = (configuredProvider as Record<string, unknown>)["base_url"];
                if (typeof baseUrl === "string" && baseUrl.length > 0) {
                    return {apiType: "openai", baseUrl};
                }
            }
        }
        return {apiType: "openai", baseUrl: DEFAULT_OPENAI_BASE_URL};
    }

    /**
     * `providers/set`: replaces the full configuration for the custom gateway
     * provider. Rejects unknown provider ids with `invalid_params`.
     */
    setProvider(request: acp.SetProviderRequest): void {
        if (request.providerId !== OPENAI_PROVIDER_ID) {
            throw RequestError.invalidParams(
                {providerId: request.providerId},
                `Unknown providerId "${request.providerId}"; only "${OPENAI_PROVIDER_ID}" is configurable`,
            );
        }
        this.applyGatewayConfig({
            apiType: request.apiType,
            baseUrl: request.baseUrl,
            headers: request.headers,
        });
        logger.log("providers/set applied", {
            providerId: request.providerId,
            apiType: request.apiType,
            baseUrl: request.baseUrl,
            headerNames: Object.keys(request.headers ?? {}),
        });
    }

    /**
     * `providers/disable`: disables the custom gateway provider. Disabling an
     * unknown provider id is idempotent success (RFD behavior §7).
     */
    disableProvider(request: acp.DisableProviderRequest): void {
        const overrideWasActive = this.gatewayConfig !== null;
        if (request.providerId === OPENAI_PROVIDER_ID) {
            this.gatewayConfig = null;
        }
        const current = this.gatewayConfig
            ? {
                apiType: gatewayApiTypeFromConfig(this.gatewayConfig),
                baseUrl: this.gatewayConfig.config.base_url,
            }
            : this.getNativeProviderConfig();
        logger.log("providers/disable applied", {
            providerId: request.providerId,
            knownProvider: request.providerId === OPENAI_PROVIDER_ID,
            overrideWasActive,
            overrideActive: this.gatewayConfig !== null,
            restoredApiType: current.apiType,
            restoredBaseUrl: current.baseUrl,
        });
    }

    async getAccount(): Promise<GetAccountResponse> {
        return this.codexClient.accountRead({refreshToken: false});
    }

    async resumeSession(request: acp.ResumeSessionRequest, onSubscribed?: () => void): Promise<SessionMetadata> {
        const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
        await this.refreshSkills(request.cwd, additionalDirectories);

        const response = await this.codexClient.threadResume({
            config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers ?? []),
            cwd: request.cwd,
            modelProvider: await this.getResumeModelProvider(),
            threadId: request.sessionId,
        });
        onSubscribed?.();
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
            collaborationMode: this.getCollaborationMode(response.thread.id),
            modelProvider: response.modelProvider,
            currentServiceTier: response.serviceTier as ServiceTier ?? null,
            additionalDirectories,
        }
    }

    async forkSession(request: acp.ForkSessionRequest): Promise<SessionMetadata> {
        const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
        return await runForkSession(request, additionalDirectories, {
            codexClient: this.codexClient,
            refreshSkills: (cwd, directories) => this.refreshSkills(cwd, directories),
            createSessionConfig: (cwd, directories, mcpServers) =>
                this.createSessionConfig(cwd, directories, mcpServers),
            getResumeModelProvider: () => this.getResumeModelProvider(),
            fetchAvailableModels: () => this.fetchAvailableModels(),
            createCurrentModelId: (models, model, reasoningEffort) =>
                this.createModelId(models, model, reasoningEffort).toString(),
            getCollaborationMode: sessionId => this.getCollaborationMode(sessionId),
        });
    }

    async loadSession(request: acp.LoadSessionRequest, onSubscribed?: () => void): Promise<SessionMetadataWithThread> {
        const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
        await this.refreshSkills(request.cwd, additionalDirectories);

        const response = await this.codexClient.threadResume({
            config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers ?? []),
            cwd: request.cwd,
            modelProvider: await this.getResumeModelProvider(),
            threadId: request.sessionId,
        });
        onSubscribed?.();
        const historyResponse = await this.codexClient.threadRead({
            threadId: response.thread.id,
            includeTurns: true,
        });
        const codexModels = await this.fetchAvailableModels();
        const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
        return {
            sessionId: request.sessionId,
            currentModelId: currentModelId,
            models: codexModels,
            collaborationMode: this.getCollaborationMode(response.thread.id),
            modelProvider: response.modelProvider,
            currentServiceTier: response.serviceTier as ServiceTier ?? null,
            thread: historyResponse.thread,
            additionalDirectories,
        };
    }

    async readSessionThread(sessionId: string): Promise<Thread> {
        return (await this.codexClient.threadRead({
            threadId: sessionId,
            includeTurns: true,
        })).thread;
    }

    async newSession(request: acp.NewSessionRequest): Promise<SessionMetadata> {
        const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
        await this.refreshSkills(request.cwd, additionalDirectories);

        const response = await this.codexClient.threadStart({
            config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers),
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
            collaborationMode: this.getCollaborationMode(response.thread.id),
            modelProvider: response.modelProvider,
            currentServiceTier: response.serviceTier as ServiceTier ?? null,
            additionalDirectories,
        };
    }

    async closeSession(sessionId: string): Promise<void> {
        try {
            await this.codexClient.threadUnsubscribe({threadId: sessionId});
        } finally {
            this.codexClient.clearThreadHandlers(sessionId);
            this.subagents.clear(sessionId);
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.codexClient.threadArchive({threadId: sessionId});
    }

    async runReview(
        sessionId: string,
        target: ReviewTarget,
        onTurnStarted?: (turnId: string, threadId: string) => void,
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

    async getGoal(sessionId: string): Promise<ThreadGoal | null> {
        const response = await this.codexClient.threadGoalGet({threadId: sessionId});
        return response?.goal ?? null;
    }

    async setGoal(
        sessionId: string,
        objective: string,
        onTurnStarted?: (turnId: string) => void,
        onGoalSet?: (goal: ThreadGoal) => void,
    ): Promise<TurnCompletedNotification | null> {
        const params = {
            threadId: sessionId,
            objective,
            status: "active",
        } as const;
        if (onGoalSet === undefined) {
            return await this.codexClient.runGoalSet(params, onTurnStarted);
        }
        return await this.codexClient.runGoalSet(params, onTurnStarted, undefined, onGoalSet);
    }

    async setGoalStatus(sessionId: string, status: ThreadGoalStatus): Promise<ThreadGoal> {
        let updatedGoal: ThreadGoal | null = null;
        await this.codexClient.runGoalSet({
            threadId: sessionId,
            status,
        }, undefined, undefined, (goal) => {
            updatedGoal = goal;
        });
        if (updatedGoal === null) {
            throw new Error(`Goal update for session ${sessionId} returned no goal`);
        }
        return updatedGoal;
    }

    async resumeGoal(
        sessionId: string,
        onTurnStarted?: (turnId: string) => void,
        onGoalSet?: (goal: ThreadGoal) => void,
    ): Promise<TurnCompletedNotification | null> {
        const params = {
            threadId: sessionId,
            status: "active",
        } as const;
        if (onGoalSet === undefined) {
            return await this.codexClient.runGoalSet(params, onTurnStarted);
        }
        return await this.codexClient.runGoalSet(params, onTurnStarted, undefined, onGoalSet);
    }

    async clearGoal(sessionId: string): Promise<void> {
        await this.codexClient.runGoalClear({threadId: sessionId});
    }

    async awaitMcpServerStartup(serverNames: Array<string>, afterVersion: number): Promise<McpStartupResult> {
        return await this.codexClient.awaitMcpServerStartup(serverNames, afterVersion);
    }

    getMcpServerStartupVersion(): number {
        return this.codexClient.getMcpServerStartupVersion();
    }

    private async createSessionConfig(
        projectPath: string,
        additionalDirectories: string[],
        mcpServers: Array<McpServer>
    ): Promise<JsonObject> {
        const sessionRoots = [projectPath, ...additionalDirectories];
        const activeProvider = this.gatewayConfig
            ? {
                apiType: gatewayApiTypeFromConfig(this.gatewayConfig),
                baseUrl: this.gatewayConfig.config.base_url,
            }
            : this.getNativeProviderConfig();
        logger.log("Creating session config", {
            projectPath,
            overrideActive: this.gatewayConfig !== null,
            modelProvider: this.getModelProvider(),
            apiType: activeProvider.apiType,
            baseUrl: activeProvider.baseUrl,
        });
        const mergedConfig = {
            ...mergeGatewayConfig(this.config, this.gatewayConfig),
            projects: Object.fromEntries(sessionRoots.map(root => [root, {
                trust_level: "trusted",
            }])),
        };
        const configWithWorkspaceRoots = mergeSandboxWorkspaceWriteRoots(mergedConfig, additionalDirectories);
        if (mcpServers.length === 0) {
            return configWithWorkspaceRoots;
        }

        const requestedServers = mcpServers.map(mcp => ({
            name: sanitizeMcpServerName(mcp.name),
            server: mcp,
        }));
        let serversToConfigure = requestedServers;
        if (shouldDeduplicateMcpConflicts()) {
            // Prevents Codex from deep-merging incompatible field types, such as url and stdio schemas.
            const existingNames = await this.getConfigMcpServerNames(projectPath);
            serversToConfigure = requestedServers.filter(mcp => !existingNames.has(mcp.name));
        }
        if (serversToConfigure.length === 0) {
            return configWithWorkspaceRoots;
        }

        return {
            ...configWithWorkspaceRoots,
            "mcp_servers": Object.fromEntries(serversToConfigure.map(mcp => [mcp.name, this.createMcpSeverConfig(mcp.server)])),
        };
    }

    private async getConfigMcpServerNames(projectPath: string): Promise<Set<string>> {
        const response = await this.codexClient.configRead({ includeLayers: true, cwd: projectPath });
        const effectiveMcpServers = response?.config?.["mcp_servers"];
        const configLayers = response?.layers ?? [];
        const layerMcpServers = configLayers.map(layer => {
            return isJsonObject(layer.config) ? layer.config["mcp_servers"] : undefined;
        });
        const configuredMcpServers = [effectiveMcpServers, ...layerMcpServers].filter(isJsonObject);
        if (configuredMcpServers.length === 0) {
            return new Set();
        }
        return new Set(configuredMcpServers.flatMap(server => Object.keys(server)));
    }

    getModelProvider(): string | null {
        return this.gatewayConfig?.modelProvider ?? this.modelProvider;
    }

    private async getResumeModelProvider(): Promise<string> {
        // Prefer an explicit/gateway provider, then the provider persisted in Codex config.
        // Keep OpenAI as the final fallback for ChatGPT-authenticated sessions without a configured provider.
        return (await this.getCurrentModelProvider()) ?? "openai";
    }

    private async refreshSkills(
        cwd: string,
        additionalRoots: string[]
    ): Promise<void> {
        if (!cwd) {
            return;
        }

        const skillExtraRoots = additionalRoots.map(root => path.join(root, ".agents", "skills"));
        if (!arraysEqual(this.skillExtraRoots, skillExtraRoots)) {
            await this.codexClient.skillsExtraRootsSet({ extraRoots: skillExtraRoots });
            this.skillExtraRoots = skillExtraRoots;
        }
        await this.codexClient.listSkills({
            cwds: [cwd, ...additionalRoots],
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
        const selectedModel = availableModels.find(m => m.id === modelId);
        if (selectedModel) {
            return ModelId.create(selectedModel.id, reasoningEffort ?? selectedModel.defaultReasoningEffort);
        }

        // The configured model is not in Codex's advertised catalog. This is
        // expected for custom providers (e.g. a self-hosted or third-party
        // model), whose model ids the catalog does not enumerate. Keep the
        // requested model id instead of silently substituting the built-in
        // default. This mirrors the Codex CLI, which keeps the configured model
        // and merely warns "Model metadata not found. Defaulting to fallback
        // metadata." Substituting the default here pins a wrong model id onto
        // every turn and makes requests to custom-provider endpoints fail with
        // "unknown model".
        if (modelId) {
            return ModelId.create(modelId, reasoningEffort ?? "medium");
        }

        const defaultModel = availableModels.find(m => m.isDefault);
        if (!defaultModel) {
            throw new Error(`Model selection failed: No model found for ID "${modelId}" and no default model is defined.`);
        }

        return ModelId.create(defaultModel.id, reasoningEffort ?? defaultModel.defaultReasoningEffort);
    }

    async subscribeToSessionEvents(
        sessionId: string,
        eventHandler: (result: ServerNotification) => void | Promise<void>,
        approvalHandler: ApprovalHandler,
        elicitationHandler: ElicitationHandler,
        supportsSubagents: boolean,
        observeInteraction: (result: ServerNotification) => void | Promise<void>,
        waitForChildSession: (childThreadId: string) => Promise<string | null>,
    ) {
        const dispatch = (event: ServerNotification) => {
            this.enqueueSessionNotification(sessionId, () => eventHandler(event));
        };
        this.subagents.subscribe({
            rootSessionId: sessionId,
            supportsSubagents,
            dispatch,
            enqueueInteraction: (event) => {
                // Child observation uses the same serialized, error-reporting queue
                // as ordinary session notifications; callers intentionally do not
                // await the callback registered with app-server.
                this.enqueueSessionNotification(sessionId, () => observeInteraction(event));
            },
            approvalHandler,
            elicitationHandler,
            waitForRootNotifications: () => this.waitForSessionNotifications(sessionId),
            waitForChildSession,
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
        additionalDirectories: string[],
        onTurnStarted?: (turnId: string) => void,
        shouldCancel?: () => boolean,
    ): Promise<TurnCompletedNotification | null> {
        const input = buildPromptItems(request.prompt);
        const effort = modelId.effort as ReasoningEffort | null; //TODO remove unsafe conversion
        await this.refreshSkills(cwd, additionalDirectories);
        if (shouldCancel?.()) {
            return null;
        }
        return await this.codexClient.runTurn({
            threadId: request.sessionId,
            input: input,
            approvalPolicy: agentMode.approvalPolicy,
            approvalsReviewer: agentMode.approvalsReviewer,
            sandboxPolicy: addAdditionalDirectoriesToSandboxPolicy(agentMode.sandboxPolicy, additionalDirectories),
            summary: disableSummary ? "none" : "auto",
            effort: effort,
            model: modelId.model,
            serviceTier: serviceTier,
        }, onTurnStarted);
    }

    async runAgentFileChangeReport(params: {
        sessionId: string;
        turnId: string;
        requestId: string;
        workspace: AgentFileChangeWorkspace;
        signal?: AbortSignal;
    }): Promise<AgentFileChangeReport> {
        if (params.signal?.aborted) {
            return createUnavailableAgentFileChangeReport(params.requestId, "cancelled");
        }

        const budget = new AgentFileChangeReportBudget(params.signal);
        let forkThreadId: string | null = null;
        let auditTurnId: string | null = null;
        let auditTurnCompleted = false;
        let lateStopReason: "cancelled" | "timeout" | null = null;
        try {
            const forkPromise = this.codexClient.threadFork({
                threadId: params.sessionId,
                lastTurnId: params.turnId,
                cwd: params.workspace.cwd,
                approvalPolicy: "never",
                sandbox: "read-only",
                developerInstructions: AGENT_FILE_CHANGE_REPORT_DEVELOPER_INSTRUCTIONS,
                ephemeral: true,
            });
            void forkPromise.then(fork => {
                if (lateStopReason !== null && forkThreadId === null) {
                    void this.unsubscribeAgentFileChangeReportThread(fork.thread.id, budget);
                }
            }, () => {});
            const fork = await budget.wait(forkPromise);
            forkThreadId = fork.thread.id;

            const turnPromise = this.codexClient.runTurn({
                threadId: forkThreadId,
                input: [{
                    type: "text",
                    text: createAgentFileChangeReportPrompt(params.workspace),
                    text_elements: [],
                }],
                cwd: params.workspace.cwd,
                approvalPolicy: "never",
                sandboxPolicy: {type: "readOnly", networkAccess: false},
                summary: "none",
                outputSchema: AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA,
            }, (turnId) => {
                auditTurnId = turnId;
                if (lateStopReason !== null && forkThreadId !== null) {
                    void this.interruptAgentFileChangeReport(forkThreadId, turnId, lateStopReason, budget);
                }
            });
            const outcome = await budget.wait(turnPromise);
            auditTurnCompleted = true;
            return createReportedAgentFileChangeReport(
                params.requestId,
                outcome.turn,
                params.workspace,
            );
        } catch (error) {
            if (error instanceof AgentFileChangeReportBudgetError) {
                lateStopReason = error.reason;
                if (!auditTurnCompleted && forkThreadId !== null && auditTurnId !== null) {
                    await this.interruptAgentFileChangeReport(
                        forkThreadId,
                        auditTurnId,
                        error.reason,
                        budget,
                    );
                }
                return createUnavailableAgentFileChangeReport(params.requestId, error.reason);
            }
            if (error instanceof AgentFileChangeReportError) {
                logger.error("Agent file-change report unavailable", error);
                return createUnavailableAgentFileChangeReport(params.requestId, error.reason);
            }
            logger.error("Agent file-change report failed", error);
            return createUnavailableAgentFileChangeReport(params.requestId, "providerError");
        } finally {
            if (forkThreadId !== null) {
                await this.unsubscribeAgentFileChangeReportThread(forkThreadId, budget);
            }
        }
    }

    private async interruptAgentFileChangeReport(
        threadId: string,
        turnId: string,
        reason: "cancelled" | "timeout",
        budget: AgentFileChangeReportBudget,
    ): Promise<void> {
        this.codexClient.markTurnStale(threadId, turnId);
        try {
            await budget.wait(this.codexClient.turnInterrupt({threadId, turnId}));
        } catch (error) {
            logger.error(`Failed to interrupt ${reason} agent file-change report`, error);
        } finally {
            this.codexClient.resolveTurnInterrupted(threadId, turnId);
        }
    }

    private async unsubscribeAgentFileChangeReportThread(
        threadId: string,
        budget: AgentFileChangeReportBudget,
    ): Promise<void> {
        try {
            await budget.wait(this.codexClient.threadUnsubscribe({threadId}));
        } catch (error) {
            logger.error("Failed to unsubscribe the agent file-change report thread", error);
        }
    }

    async setCollaborationMode(sessionId: string, mode: ModeKind, currentModelId: string): Promise<void> {
        await this.codexClient.threadSettingsUpdate({
            threadId: sessionId,
            collaborationMode: createCodexCollaborationMode(mode, currentModelId),
        });
    }

    private getCollaborationMode(sessionId: string): ModeKind {
        return this.codexClient.getThreadSettings(sessionId)?.collaborationMode.mode ?? "default";
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
            "unknown",
        ];
        const requestedCwd = request.cwd?.trim() ?? null;
        const filterByCwd = (thread: Thread): boolean => {
            if (!requestedCwd) return true;
            if (isAbsolutePathLike(requestedCwd)) {
                return arePathsEqual(thread.cwd, requestedCwd);
            }
            return arePathBasenamesEqual(thread.cwd, requestedCwd);
        };

        const preferredProvider = this.getModelProvider();
        const modelProviders = preferredProvider ? [preferredProvider] : [];
        const listResponse = await this.codexClient.threadList({
            cursor: request.cursor ?? null,
            modelProviders: modelProviders,
            sourceKinds: sourceKinds,
        });

        const mapThreadToSession = (thread: Thread) => ({
            sessionId: thread.id,
            cwd: thread.cwd,
            title: (thread.name ?? thread.preview) || null,
            updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
        });

        if (listResponse.data.length === 0) {
            const diagnostics = await this.runSessionListDiagnostics();
            logger.log("Session list diagnostics", diagnostics);
        }

        let sessions = listResponse.data.map(mapThreadToSession);
        if (requestedCwd) {
            const filtered = listResponse.data
                .filter(filterByCwd)
                .map(mapThreadToSession);
            if (filtered.length > 0 || isAbsolutePathLike(requestedCwd)) {
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

    async steerTurn(params: { threadId: string, turnId: string, prompt: acp.ContentBlock[] }): Promise<TurnSteerResponse> {
        return await this.codexClient.turnSteer({
            threadId: params.threadId,
            expectedTurnId: params.turnId,
            input: buildPromptItems(params.prompt),
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
            this.codexClient.threadList({modelProviders: [CUSTOM_GATEWAY_PROVIDER_ID]}),
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

class AgentFileChangeReportBudgetError extends Error {
    constructor(readonly reason: "cancelled" | "timeout") {
        super(`Agent file-change report ${reason}`);
        this.name = "AgentFileChangeReportBudgetError";
    }
}

/** One wall-clock budget shared by fork, turn, read, interruption, and cleanup. */
class AgentFileChangeReportBudget {
    private readonly deadline = Date.now() + AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS;

    constructor(private readonly signal?: AbortSignal) {}

    async wait<T>(operation: Promise<T>): Promise<T> {
        // A stage can outlive the race at the transport layer. Attach a handler
        // before the immediate budget checks so a late rejection is never
        // unhandled even when no time remains to await it.
        void operation.catch(() => {});
        const immediateReason = this.stopReason();
        if (immediateReason !== null) {
            throw new AgentFileChangeReportBudgetError(immediateReason);
        }

        return await new Promise<T>((resolve, reject) => {
            let settled = false;
            const finish = (action: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                this.signal?.removeEventListener("abort", onAbort);
                action();
            };
            const onAbort = (): void => finish(() => reject(new AgentFileChangeReportBudgetError("cancelled")));
            const timeout = setTimeout(
                () => finish(() => reject(new AgentFileChangeReportBudgetError("timeout"))),
                Math.max(1, this.deadline - Date.now()),
            );
            timeout.unref();
            this.signal?.addEventListener("abort", onAbort, {once: true});
            if (this.signal?.aborted) {
                onAbort();
            }
            void operation.then(
                value => finish(() => resolve(value)),
                error => finish(() => reject(error)),
            );
        });
    }

    private stopReason(): "cancelled" | "timeout" | null {
        if (this.signal?.aborted) return "cancelled";
        if (Date.now() >= this.deadline) return "timeout";
        return null;
    }
}

export type JsonObject = { [key in string]?: JsonValue }

function buildPromptItems(prompt: acp.ContentBlock[]): UserInput[] {
    return prompt.map((block): UserInput | null => {
        switch (block.type) {
            case "text":
                return {type: "text", text: block.text, text_elements: []};
            case "image": {
                const url = isSupportedImageUrl(block.uri) ? block.uri : imageDataUrl(block);
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

function imageDataUrl(block: acp.ContentBlock & { type: "image" }): string {
    return `data:${block.mimeType};base64,${block.data}`;
}

function isImageMimeType(mimeType: string | null | undefined): mimeType is string {
    return mimeType?.startsWith("image/") ?? false;
}

function isSupportedImageUrl(uri: string | null | undefined): uri is string {
    if (!uri) {
        return false;
    }
    try {
        const protocol = new URL(uri).protocol;
        return protocol === "http:" || protocol === "https:" || protocol === "data:";
    } catch {
        return false;
    }
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

function shouldDeduplicateMcpConflicts(): boolean {
    const disabledByEnv = process.env["DISABLE_MCP_CONFIG_FILTERING"] === "true";
    return !disabledByEnv;
}

type WireApi = "responses";

interface GatewayConfig {
    modelProvider: string;
    config: {
        name: string,
        base_url: string,
        http_headers: Record<string, string>,
        wire_api: WireApi
    }
}

function readMetaAdditionalRoots(meta?: Record<string, unknown> | null): string[] | undefined {
    const rawRoots = meta?.["additionalRoots"];
    if (!Array.isArray(rawRoots)) {
        return undefined;
    }

    return uniqueStrings(rawRoots
        .filter((value): value is string => typeof value === "string")
        .map(value => value.trim())
        .filter(value => value.length > 0));
}

function readAdditionalDirectories(cwd: string, additionalDirectories?: string[],  meta?: Record<string, unknown> | null): string[] {
    const rawDirectories = additionalDirectories ?? readMetaAdditionalRoots(meta);
    if (!rawDirectories) {
        return [];
    }

    const directories: string[] = [];
    const seen = new Set<string>([cwd]);
    for (const directory of rawDirectories) {
        if (typeof directory !== "string") {
            throw RequestError.invalidParams(undefined, "additionalDirectories entries must be strings");
        }
        if (directory.length === 0) {
            throw RequestError.invalidParams(undefined, "additionalDirectories entries must not be empty");
        }
        if (!path.isAbsolute(directory)) {
            throw RequestError.invalidParams(undefined, "additionalDirectories entries must be absolute paths");
        }
        if (!seen.has(directory)) {
            seen.add(directory);
            directories.push(directory);
        }
    }

    return directories;
}

function mergeSandboxWorkspaceWriteRoots(config: JsonObject, roots: string[]): JsonObject {
    if (roots.length === 0) {
        return config;
    }

    const existingSandboxConfig = isJsonObject(config["sandbox_workspace_write"])
        ? config["sandbox_workspace_write"]
        : {};
    const existingWritableRoots = Array.isArray(existingSandboxConfig["writable_roots"])
        ? existingSandboxConfig["writable_roots"].filter((value): value is string => typeof value === "string")
        : [];

    return {
        ...config,
        sandbox_workspace_write: {
            ...existingSandboxConfig,
            writable_roots: uniqueStrings([...existingWritableRoots, ...roots]),
        },
    };
}

function addAdditionalDirectoriesToSandboxPolicy(
    sandboxPolicy: SandboxPolicy,
    additionalDirectories: string[]
): SandboxPolicy {
    if (additionalDirectories.length === 0 || sandboxPolicy.type !== "workspaceWrite") {
        return sandboxPolicy;
    }

    return {
        ...sandboxPolicy,
        writableRoots: uniqueStrings([...sandboxPolicy.writableRoots, ...additionalDirectories]),
    };
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function arraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => value === right[index]);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gatewayApiTypeFromConfig(gatewayConfig: GatewayConfig): acp.LlmProtocol {
    const wireApi = gatewayConfig.config.wire_api;
    const match = Object.entries(SUPPORTED_GATEWAY_PROTOCOLS).find(([, wire]) => wire === wireApi);
    return match?.[0] ?? "openai";
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
