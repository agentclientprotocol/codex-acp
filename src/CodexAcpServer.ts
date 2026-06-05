import * as acp from "@agentclientprotocol/sdk";
import {RequestError, type SessionId, type SessionModelState, type SessionModeState} from "@agentclientprotocol/sdk";
import {CodexEventHandler} from "./CodexEventHandler";
import {CodexApprovalHandler} from "./CodexApprovalHandler";
import {CodexElicitationHandler} from "./CodexElicitationHandler";
import {type CodexAuthRequest, getCodexAuthMethods} from "./CodexAuthMethod";
import {CodexAcpClient, type SessionMetadata, type SessionMetadataWithThread} from "./CodexAcpClient";
import type {McpStartupResult} from "./CodexAppServerClient";
import {ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {InputModality, ReasoningEffort} from "./app-server";
import type {
    Account,
    CollabAgentToolCallStatus,
    Model,
    ReasoningEffortOption,
    Thread,
    ThreadItem,
    UserInput
} from "./app-server/v2";
import type {RateLimitsMap} from "./RateLimitsMap";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import type {TokenCount} from "./TokenCount";
import {toPromptUsage} from "./TokenCount";
import {CodexCommands} from "./CodexCommands";
import type {QuotaMeta} from "./QuotaMeta";
import {logger} from "./Logger";
import {isExtMethodRequest} from "./AcpExtensions";
import {
    createCommandExecutionUpdate,
    createDynamicToolCallUpdate,
    createFileChangeUpdate,
    createMcpToolCallUpdate,
} from "./CodexToolCallMapper";
import {
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_OFF,
    FAST_MODE_ON,
    modelSupportsFast,
    resolveFastServiceTier,
} from "./FastModeConfig";
import packageJson from "../package.json";

export interface SessionState {
    sessionId: string,
    currentModelId: string,
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    supportedInputModalities: Array<InputModality>,
    agentMode: AgentMode,
    currentTurnId: string | null;
    lastTokenUsage: TokenCount | null;
    totalTokenUsage: TokenCount | null;
    modelContextWindow: number | null;
    rateLimits: RateLimitsMap | null;
    account: Account | null;
    cwd: string;
    fastModeEnabled: boolean;
    currentModelSupportsFast: boolean;
    sessionMcpServers?: Array<string>;
}

interface PendingMcpStartupSession {
    requestedServers: Set<string>;
    afterVersion: number;
}

interface PendingTurnStart {
    promise: Promise<string | null>;
    resolve: (turnId: string | null) => void;
}

interface ActivePrompt {
    completion: Promise<void>;
    closeSignal: Promise<null>;
    requestClose: () => void;
    complete: () => void;
}

export class CodexAcpServer implements acp.Agent {
    private static readonly MODEL_NAME_TOKEN_OVERRIDES: Record<string, string> = {
        gpt: "GPT",
        mini: "Mini",
        codex: "Codex",
    };

    private readonly codexAcpClient: CodexAcpClient;
    private readonly connection: acp.AgentSideConnection;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;
    private readonly availableCommands: CodexCommands;

    private readonly sessions: Map<string, SessionState>;
    private readonly pendingMcpStartupSessions: Map<string, PendingMcpStartupSession>;
    private readonly pendingTurnStarts: Map<string, PendingTurnStart>;
    private readonly activePrompts: Map<string, ActivePrompt>;
    private readonly closingSessions: Set<string>;
    private readonly sessionGenerations: Map<string, number>;
    private readonly sessionOpenGenerations: Map<string, number>;

    constructor(
        connection: acp.AgentSideConnection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
        getExitCode?: () => number | null,
    ) {
        this.sessions = new Map();
        this.pendingMcpStartupSessions = new Map();
        this.pendingTurnStarts = new Map();
        this.activePrompts = new Map();
        this.closingSessions = new Set();
        this.sessionGenerations = new Map();
        this.sessionOpenGenerations = new Map();
        this.connection = connection;
        this.codexAcpClient = codexAcpClient;
        this.defaultAuthRequest = defaultAuthRequest ?? null;
        this.getExitCode = getExitCode ?? (() => null);
        this.availableCommands = new CodexCommands(
            connection,
            codexAcpClient,
            (operation) => this.runWithProcessCheck(operation)
        );
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        logger.log("Initialize request received");
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize(_params));
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            agentCapabilities: {
                auth: {
                    logout: {},
                },
                loadSession: true,
                promptCapabilities: {
                    embeddedContext: true,
                    image: true
                },
                sessionCapabilities: {
                    resume: { },
                    list: { },
                    close: { },
                },
                mcpCapabilities: {
                    acp: false,
                    http: true,
                    sse: false
                }
            },
            authMethods: getCodexAuthMethods(_params.clientCapabilities),
        };
    }

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const methodRequest = { method: method, params: params };
        if (!isExtMethodRequest(methodRequest)) {
            return {};
        }
        switch (methodRequest.method) {
            case "authentication/status":
                return await this.runWithProcessCheck(() => this.codexAcpClient.getAuthenticationStatus());
            case "authentication/logout": {
                await this.unstable_logout({});
                return {};
            }
        }
    }

    async checkAuthorization(){
        const authNeeded = await this.runWithProcessCheck(() => this.codexAcpClient.authRequired());
        logger.log("Auth requirement checked", {authRequired: authNeeded});
        if (authNeeded) {
            if (this.defaultAuthRequest) {
                logger.log("Authenticating with default auth request...", {
                    authRequest: this.defaultAuthRequest
                });
                await this.authenticate(this.defaultAuthRequest)
                logger.log("Authentication completed");
            } else {
                logger.log("Authentication required but no default auth request provided, return to IDE");
                throw RequestError.authRequired();
            }
        }
    }

    async getOrCreateSession(request: acp.NewSessionRequest | acp.ResumeSessionRequest): Promise<[SessionId, SessionModelState, SessionModeState]> {
        try {
            return await this.tryCreateSession(request);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            await this.handleError(error);
            throw e;
        }
    }

    async handleError(e: Error){
        if (e.message.includes("log out")) {
            await this.runWithProcessCheck(() => this.codexAcpClient.logout());
            throw RequestError.internalError(`${(e.message)}\n\nYou have been logged out. Please try again.`);
        }
    }

    private beginSessionOpen(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId);
        if (this.closingSessions.has(sessionId)) {
            throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
        }
        this.sessionOpenGenerations.set(sessionId, generation);
        return generation;
    }

    private sessionOpenCanInstall(sessionId: string, generation: number): boolean {
        return !this.closingSessions.has(sessionId) && this.getSessionGeneration(sessionId) === generation;
    }

    private async closeStaleSessionOpen(sessionId: string, generation: number): Promise<void> {
        if (this.sessionOpenGenerations.get(sessionId) === generation) {
            const staleCloseGeneration = this.bumpSessionGeneration(sessionId);
            this.closingSessions.add(sessionId);
            try {
                await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(sessionId));
            } catch (err) {
                logger.error(`Failed to close stale session open for ${sessionId}`, err);
            } finally {
                if (this.getSessionGeneration(sessionId) === staleCloseGeneration) {
                    this.closingSessions.delete(sessionId);
                }
            }
        }
        throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
    }

    private getSessionGeneration(sessionId: string): number {
        return this.sessionGenerations.get(sessionId) ?? 0;
    }

    private bumpSessionGeneration(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId) + 1;
        this.sessionGenerations.set(sessionId, generation);
        return generation;
    }

    async tryCreateSession(request: acp.NewSessionRequest | acp.ResumeSessionRequest): Promise<[SessionId, SessionModelState, SessionModeState]> {
        const requestedSessionGeneration = "sessionId" in request
            ? this.beginSessionOpen(request.sessionId)
            : null;
        await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const mcpServerStartupVersion = requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;

        let sessionMetadata: SessionMetadata;
        if ("sessionId" in request) {
            logger.log(`Resume existing session: ${request.sessionId}...`)
            sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.resumeSession(request));
        } else {
            logger.log(`Create new session...`)
            sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.newSession(request));
        }

        const account = await this.getActiveAccount();
        const {sessionId, currentModelId, models} = sessionMetadata;
        const sessionGeneration = requestedSessionGeneration ?? this.beginSessionOpen(sessionId);
        if (!this.sessionOpenCanInstall(sessionId, sessionGeneration)) {
            await this.closeStaleSessionOpen(sessionId, sessionGeneration);
        }
        const sessionMcpServers = this.resolveSessionMcpServers(requestedMcpServers, "sessionId" in request);
        const currentModel = this.findCurrentModel(models, currentModelId);
        const currentModelSupportsFast = modelSupportsFast(currentModel);
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            supportedReasoningEfforts: currentModel?.supportedReasoningEfforts ?? [],
            supportedInputModalities: currentModel?.inputModalities ?? ["text", "image"],
            agentMode: AgentMode.getInitialAgentMode(),
            currentTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: account,
            cwd: request.cwd,
            fastModeEnabled: sessionMetadata.currentServiceTier === "fast",
            currentModelSupportsFast: currentModelSupportsFast,
            sessionMcpServers: sessionMcpServers,
        }
        this.sessions.set(sessionId, sessionState);

        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            this.pendingMcpStartupSessions.set(sessionId, {
                requestedServers: new Set(requestedMcpServers.map(server => server.name)),
                afterVersion: mcpServerStartupVersion,
            });
            this.publishMcpStartupStatusAsync(sessionId);
        }

        this.publishAvailableCommandsAsync(sessionId);
        const sessionModelState: SessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState = sessionState.agentMode.toSessionModeState();

        return [sessionId, sessionModelState, sessionModeState];
    }

    private async getActiveAccount(){
        if (this.codexAcpClient.getModelProvider()) {
            return null
        }
        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        return accountResponse.account;
    }

    async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
        logger.log("Loading session...", {sessionId: params.sessionId});
        const {
            sessionId,
            modelState,
            modeState,
            thread,
        } = await this.getOrCreateSessionWithHistory(params);

        await this.streamThreadHistory(sessionId, thread);

        logger.log("Session loaded", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState,
            configOptions: this.createSessionConfigOptions(this.getSessionState(sessionId)),
        };
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        logger.log("Resuming session...", {sessionId: params.sessionId});
        const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);

        logger.log("Session resumed", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState,
            configOptions: this.createSessionConfigOptions(this.getSessionState(sessionId)),
        };
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        logger.log("Listing sessions...", {cwd: params.cwd, cursor: params.cursor});
        await this.checkAuthorization();
        return await this.runWithProcessCheck(() => this.codexAcpClient.listSessions(params));
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        logger.log("Closing session...", {sessionId: params.sessionId});
        const closeGeneration = this.bumpSessionGeneration(params.sessionId);
        const sessionState = this.sessions.get(params.sessionId);
        this.closingSessions.add(params.sessionId);

        try {
            if (sessionState) {
                await this.interruptSessionTurn(sessionState, "Close", true);
            } else {
                logger.log("Close request received for unknown local session", {sessionId: params.sessionId});
            }

            const activePrompt = this.activePrompts.get(params.sessionId);
            if (activePrompt) {
                activePrompt.requestClose();
                await activePrompt.completion;
            }

            await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(params.sessionId));
            logger.log("Session closed", {sessionId: params.sessionId});
        } finally {
            if (this.getSessionGeneration(params.sessionId) === closeGeneration) {
                this.sessions.delete(params.sessionId);
                this.pendingMcpStartupSessions.delete(params.sessionId);
                this.pendingTurnStarts.delete(params.sessionId);
                this.activePrompts.delete(params.sessionId);
                this.closingSessions.delete(params.sessionId);
            }
        }

        return {};
    }

    async newSession(
        params: acp.NewSessionRequest,
    ): Promise<acp.NewSessionResponse> {
        logger.log("Starting new session...");
        const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);

        logger.log("New session created", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });

        return {
            sessionId: sessionId,
            models: modelState,
            modes: modeState,
            configOptions: this.createSessionConfigOptions(this.getSessionState(sessionId)),
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
    ): Promise<acp.AuthenticateResponse> {
        logger.log("Authenticate request received");
        const isAuthenticated = await this.runWithProcessCheck(() => this.codexAcpClient.authenticate(_params));
        if (!isAuthenticated) {
            logger.log("Authenticate request failed");
            throw RequestError.invalidParams();
        }
        logger.log("Authenticate request completed");
        return { };
    }

    async unstable_logout(_params: acp.LogoutRequest): Promise<void> {
        logger.log("Logout request received");
        await this.runWithProcessCheck(() => this.codexAcpClient.logout());
        logger.log("Logout request completed");
    }

    async setSessionMode(
        _params: acp.SetSessionModeRequest,
    ): Promise<acp.SetSessionModeResponse> {
        logger.log("Set session mode requested", {
            sessionId: _params.sessionId,
            modeId: _params.modeId
        });
        const sessionState = this.sessions.get(_params.sessionId);
        if (!sessionState) throw new Error(`Session ${_params.sessionId} not found`);

        const newMode = AgentMode.find(_params.modeId);
        if (!newMode) {
            throw RequestError.invalidParams();
        }
        sessionState.agentMode = newMode;
        return {};
    }

    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        logger.log("Set session config option requested", {
            sessionId: params.sessionId,
            configId: params.configId,
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        if (params.configId !== FAST_MODE_CONFIG_ID || ("type" in params && params.type === "boolean")) {
            throw RequestError.invalidParams();
        }

        if (params.value !== FAST_MODE_ON && params.value !== FAST_MODE_OFF) {
            throw RequestError.invalidParams();
        }

        sessionState.fastModeEnabled = params.value === FAST_MODE_ON;
        return {
            configOptions: this.createSessionConfigOptions(sessionState),
        };
    }

    async unstable_setSessionModel(params: acp.SetSessionModelRequest): Promise<acp.SetSessionModelResponse | void> {
        logger.log("Set session model requested", {
            sessionId: params.sessionId,
            modelId: params.modelId
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        const requestedModelId= ModelId.fromString(params.modelId);
        const requestedModelName = requestedModelId.model;
        const requestedEffort = requestedModelId.effort;

        const models = await this.codexAcpClient.fetchAvailableModels();
        const model = models.find(m => m.id === requestedModelName);
        if (!model) throw new Error(`Unknown model ${params.modelId}`);

        const requestedEffortValue = requestedEffort as ReasoningEffort | undefined;
        let reasoningEffort: ReasoningEffort;
        if (requestedEffortValue) {
            const matchedEffort = model.supportedReasoningEfforts.find(
                (option) => option.reasoningEffort === requestedEffortValue
            )?.reasoningEffort;

            if (!matchedEffort) {
                throw new Error(`Unsupported reasoning effort ${requestedEffortValue} for model ${requestedModelName}`);
            }

            reasoningEffort = matchedEffort;
        } else {
            reasoningEffort = model.defaultReasoningEffort;
        }

        sessionState.currentModelId = ModelId.fromComponents(model, reasoningEffort).toString();
        sessionState.supportedReasoningEfforts = model.supportedReasoningEfforts;
        sessionState.supportedInputModalities = model.inputModalities;
        sessionState.currentModelSupportsFast = modelSupportsFast(model);

        return {};
    }

    private createSessionConfigOptions(sessionState: SessionState): Array<acp.SessionConfigOption> {
        return [
            createFastModeConfigOption(sessionState.fastModeEnabled),
        ];
    }

    private publishAvailableCommandsAsync(sessionId: string) {
        void this.availableCommands.publish(sessionId);
    }

    private findCurrentModel(models: Model[], currentModelId: string): Model | undefined {
        const modelId = ModelId.fromString(currentModelId);
        return models.find(m => m.id === modelId.model);
    }

    private normalizeModelDisplayName(displayName: string): string {
        return displayName
            .split("-")
            .map((token) => CodexAcpServer.MODEL_NAME_TOKEN_OVERRIDES[token.toLowerCase()] ?? token)
            .join("-");
    }

    private createModelState(availableModels: Model[], selectedModelId: string): SessionModelState {
        const allowedModels = availableModels
            .flatMap((model) =>
                model.supportedReasoningEfforts.map((effort) => ({
                    modelId: ModelId.fromComponents(model, effort.reasoningEffort).toString(),
                    name: `${this.normalizeModelDisplayName(model.displayName)} (${effort.reasoningEffort})`,
                    description: `${model.description} ${effort.description}`,
                }))
            );
        return {
            availableModels: allowedModels,
            currentModelId: selectedModelId,
        }
    }

    private async getOrCreateSessionWithHistory(
        request: acp.LoadSessionRequest
    ): Promise<{
        sessionId: SessionId;
        modelState: SessionModelState;
        modeState: SessionModeState;
        thread: Thread;
    }> {
        const requestedSessionGeneration = this.beginSessionOpen(request.sessionId);
        await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const mcpServerStartupVersion = requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;

        logger.log(`Load existing session: ${request.sessionId}...`);
        const sessionMetadata: SessionMetadataWithThread = await this.runWithProcessCheck(() =>
            this.codexAcpClient.loadSession(request)
        );

        const account = await this.getActiveAccount();
        const {sessionId, currentModelId, models, thread} = sessionMetadata;
        if (!this.sessionOpenCanInstall(sessionId, requestedSessionGeneration)) {
            await this.closeStaleSessionOpen(sessionId, requestedSessionGeneration);
        }
        const sessionMcpServers = this.resolveSessionMcpServers(requestedMcpServers, true);
        const currentModel = this.findCurrentModel(models, currentModelId);
        const currentModelSupportsFast = modelSupportsFast(currentModel);
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            supportedReasoningEfforts: currentModel?.supportedReasoningEfforts ?? [],
            supportedInputModalities: currentModel?.inputModalities ?? ["text", "image"],
            agentMode: AgentMode.getInitialAgentMode(),
            currentTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: account,
            cwd: request.cwd,
            fastModeEnabled: sessionMetadata.currentServiceTier === "fast",
            currentModelSupportsFast: currentModelSupportsFast,
            sessionMcpServers: sessionMcpServers,
        };
        this.sessions.set(sessionId, sessionState);

        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            this.pendingMcpStartupSessions.set(sessionId, {
                requestedServers: new Set(requestedMcpServers.map(server => server.name)),
                afterVersion: mcpServerStartupVersion,
            });
            this.publishMcpStartupStatusAsync(sessionId);
        }

        await this.availableCommands.publish(sessionId);
        const sessionModelState: SessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState = sessionState.agentMode.toSessionModeState();

        return {
            sessionId: sessionId,
            modelState: sessionModelState,
            modeState: sessionModeState,
            thread: thread,
        };
    }

    private async streamThreadHistory(sessionId: string, thread: Thread): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        for (const turn of thread.turns) {
            for (const item of turn.items) {
                const updates = await this.createHistoryUpdates(item);
                for (const update of updates) {
                    await session.update(update);
                }
            }
        }
    }

    private async createHistoryUpdates(item: ThreadItem): Promise<UpdateSessionEvent[]> {
        switch (item.type) {
            case "userMessage":
                return this.createUserMessageUpdates(item);
            case "hookPrompt":
                return [];
            case "agentMessage":
                return [{
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: item.text },
                }];
            case "reasoning":
                return this.createReasoningUpdates(item);
            case "fileChange":
                return [await createFileChangeUpdate(item)];
            case "commandExecution":
                return [await createCommandExecutionUpdate(item)];
            case "mcpToolCall":
                return [await createMcpToolCallUpdate(item)];
            case "dynamicToolCall":
                return [await createDynamicToolCallUpdate(item)];
            case "collabAgentToolCall":
                return [this.createCollabAgentToolCallUpdate(item)];
            case "webSearch":
                return [this.createWebSearchUpdate(item)];
            case "imageView":
                return [this.createImageViewUpdate(item)];
            case "imageGeneration":
                return [];
            case "enteredReviewMode":
                return [this.createReviewModeUpdate(item, true)];
            case "exitedReviewMode":
                return [this.createReviewModeUpdate(item, false)];
            case "contextCompaction":
                return [this.createContextCompactionUpdate()];
            case "plan":
                return [this.createPlanUpdate(item)];
        }
    }

    private createUserMessageUpdates(item: ThreadItem & { type: "userMessage" }): UpdateSessionEvent[] {
        const updates: UpdateSessionEvent[] = [];
        for (const input of item.content) {
            const blocks = this.userInputToContentBlocks(input);
            for (const block of blocks) {
                updates.push({
                    sessionUpdate: "user_message_chunk",
                    content: block,
                });
            }
        }
        return updates;
    }

    private createReasoningUpdates(item: ThreadItem & { type: "reasoning" }): UpdateSessionEvent[] {
        const parts = item.summary.length > 0 ? item.summary : item.content;
        return parts.map((text) => ({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: text },
        }));
    }

    private createCollabAgentToolCallUpdate(
        item: ThreadItem & { type: "collabAgentToolCall" }
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            kind: "other",
            title: `collab.${item.tool}`,
            status: this.toAcpToolCallStatus(item.status),
            rawInput: {
                prompt: item.prompt,
                senderThreadId: item.senderThreadId,
                receiverThreadIds: item.receiverThreadIds,
                agentsStates: item.agentsStates,
                status: item.status,
            },
        };
    }

    private createWebSearchUpdate(
        item: ThreadItem & { type: "webSearch" }
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            kind: "search",
            title: this.formatWebSearchTitle(item),
            status: "completed",
            rawInput: {
                query: item.query,
                action: item.action,
            },
        };
    }

    private createImageViewUpdate(
        item: ThreadItem & { type: "imageView" }
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: item.id,
            kind: "read",
            title: "View image",
            status: "completed",
            locations: [{ path: item.path }],
            rawInput: {
                path: item.path,
            },
        };
    }

    private createReviewModeUpdate(
        item: ThreadItem & { type: "enteredReviewMode" | "exitedReviewMode" },
        entered: boolean
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `${entered ? "Entered" : "Exited"} review mode: ${item.review}`,
            },
        };
    }

    private createContextCompactionUpdate(): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: "Context compacted.",
            },
        };
    }

    private createPlanUpdate(
        item: ThreadItem & { type: "plan" }
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            content: {
                type: "text",
                text: `Plan:\n${item.text}`,
            },
        };
    }

    private formatWebSearchTitle(item: ThreadItem & { type: "webSearch" }): string {
        const action = item.action;
        if (!action) {
            return item.query ? `Web search: ${item.query}` : "Web search";
        }
        switch (action.type) {
            case "search": {
                const queries = action.queries?.filter((query) => query && query.length > 0) ?? [];
                const query = action.query ?? (queries.length > 0 ? queries.join(", ") : null) ?? item.query;
                return query ? `Web search: ${query}` : "Web search";
            }
            case "openPage":
                return action.url ? `Open page: ${action.url}` : "Open page";
            case "findInPage": {
                const pattern = action.pattern ? ` for '${action.pattern}'` : "";
                const url = action.url ? ` in ${action.url}` : "";
                return `Find in page${pattern}${url}`.trim();
            }
            case "other":
                return "Web search";
        }
    }

    private toAcpToolCallStatus(status: CollabAgentToolCallStatus): "in_progress" | "completed" | "failed" {
        switch (status) {
            case "inProgress":
                return "in_progress";
            case "completed":
                return "completed";
            case "failed":
                return "failed";
        }
    }

    private userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
        switch (input.type) {
            case "text":
                return input.text.length > 0 ? [{ type: "text", text: input.text }] : [];
            case "image":
                return [{ type: "text", text: this.formatUriAsLink("image", input.url) }];
            case "localImage": {
                const uri = input.path.startsWith("file://") ? input.path : `file://${input.path}`;
                return [{ type: "text", text: this.formatUriAsLink(null, uri) }];
            }
            case "skill":
                return [{ type: "text", text: `skill:${input.name} (${input.path})` }];
        }
        return [];
    }

    private formatUriAsLink(name: string | null, uri: string): string {
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

    getSessionState(sessionId: string): SessionState {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) {
            throw new Error(`Session ${sessionId} not found`);
        }
        return sessionState;
    }

    private resolveSessionMcpServers(
        mcpServers: Array<acp.McpServer>,
        recoverFromStartup: boolean,
    ): Array<string> {
        // Explicit MCP servers from the request are the primary source of truth for the session.
        const requestedServerNames = getRequestedMcpServerNames(mcpServers);
        if (requestedServerNames.length > 0) {
            return requestedServerNames;
        }
        // Fresh sessions without MCP config should not inherit any session MCP state.
        if (!recoverFromStartup) {
            return [];
        }
        // Without a thread-scoped startup completion event, loadSession/resumeSession can no longer
        // recover omitted session MCP server names. Treat the session set as unknown unless ACP
        // explicitly provided mcpServers in the request.
        logger.log("Skipping MCP server recovery for load/resume without explicit mcpServers");
        return [];
    }

    private publishMcpStartupStatusAsync(sessionId: string): void {
        void this.doPublishMcpStartupStatus(sessionId);
    }

    private async doPublishMcpStartupStatus(sessionId: string): Promise<void> {
        const pendingStartup = this.pendingMcpStartupSessions.get(sessionId);
        if (!pendingStartup) {
            return;
        }

        try {
            const mcpStartup = await this.runWithProcessCheck(() =>
                this.codexAcpClient.awaitMcpServerStartup(
                    Array.from(pendingStartup.requestedServers),
                    pendingStartup.afterVersion,
                )
            );
            if (!this.sessions.has(sessionId)
                || this.closingSessions.has(sessionId)
                || this.pendingMcpStartupSessions.get(sessionId) !== pendingStartup) {
                return;
            }
            await this.publishMcpStartupStatus(sessionId, mcpStartup, pendingStartup.requestedServers);
        } catch (err) {
            logger.error(`Failed to publish MCP startup status for session ${sessionId}`, err);
        } finally {
            if (this.pendingMcpStartupSessions.get(sessionId) === pendingStartup) {
                this.pendingMcpStartupSessions.delete(sessionId);
            }
        }
    }

    private async publishMcpStartupStatus(
        sessionId: string,
        mcpStartup: McpStartupResult,
        requestedServers?: Set<string>
    ): Promise<void> {
        const filteredStartup = requestedServers
            ? {
                ready: mcpStartup.ready.filter(server => requestedServers.has(server)),
                failed: mcpStartup.failed.filter(server => requestedServers.has(server.server)),
                cancelled: mcpStartup.cancelled.filter(server => requestedServers.has(server)),
            }
            : mcpStartup;

        for (const update of CodexEventHandler.createMcpStartupUpdates(filteredStartup)) {
            await this.connection.sessionUpdate({
                sessionId,
                update,
            });
        }
    }

    private trackActivePrompt(sessionId: string): ActivePrompt {
        let resolveCompletion: () => void = () => {};
        const completion = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
        });
        let resolveCloseSignal: (value: null) => void = () => {};
        const closeSignal = new Promise<null>((resolve) => {
            resolveCloseSignal = resolve;
        });

        let completed = false;
        let closeRequested = false;
        const activePrompt: ActivePrompt = {
            completion,
            closeSignal,
            requestClose: () => {
                if (closeRequested) {
                    return;
                }
                closeRequested = true;
                resolveCloseSignal(null);
            },
            complete: () => {
                if (completed) {
                    return;
                }
                completed = true;
                if (this.activePrompts.get(sessionId) === activePrompt) {
                    this.activePrompts.delete(sessionId);
                }
                resolveCompletion();
            },
        };

        this.activePrompts.set(sessionId, activePrompt);
        return activePrompt;
    }

    private createPendingTurnStart(): PendingTurnStart {
        let resolve: (turnId: string | null) => void = () => {};
        const promise = new Promise<string | null>((innerResolve) => {
            resolve = innerResolve;
        });
        return {promise, resolve};
    }

    private interruptLateStartedTurn(sessionId: string, turnId: string): void {
        void this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
            threadId: sessionId,
            turnId,
        })).catch((err) => {
            logger.error(`Close - late turnInterrupt failed`, err);
        }).finally(() => {
            this.codexAcpClient.resolveTurnInterrupted({
                threadId: sessionId,
                turnId,
            });
        });
    }

    private promptIsClosedOrStale(sessionId: string, activePrompt: ActivePrompt): boolean {
        return this.activePrompts.get(sessionId) !== activePrompt || this.closingSessions.has(sessionId);
    }

    private async interruptSessionTurn(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
        resolveInterruptedTurn: boolean,
    ): Promise<void> {
        const turnId = await this.getInterruptibleTurnId(sessionState, requestName);
        if (!turnId) {
            return;
        }

        logger.log(`${requestName} session requested`, {
            sessionId: sessionState.sessionId,
            currentTurnId: turnId,
        });
        try {
            await this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
                threadId: sessionState.sessionId,
                turnId,
            }));
            logger.log(`${requestName} - turnInterrupt succeeded`, {
                sessionId: sessionState.sessionId,
                currentTurnId: turnId,
            });
        } catch (err) {
            logger.error(`${requestName} - turnInterrupt failed`, err);
        } finally {
            if (resolveInterruptedTurn) {
                this.codexAcpClient.resolveTurnInterrupted({
                    threadId: sessionState.sessionId,
                    turnId,
                });
            }
        }
    }

    private async getInterruptibleTurnId(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
    ): Promise<string | null> {
        if (sessionState.currentTurnId) {
            return sessionState.currentTurnId;
        }

        const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
        if (!pendingTurnStart) {
            logger.log(`${requestName} request rejected: no current turn`, {sessionId: sessionState.sessionId});
            return null;
        }

        if (requestName === "Close") {
            pendingTurnStart.resolve(null);
            return null;
        }

        const turnId = await pendingTurnStart.promise;
        if (!turnId) {
            logger.log(`${requestName} request rejected: no current turn`, {sessionId: sessionState.sessionId});
        }
        return turnId;
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        logger.log("Prompt received", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        sessionState.currentTurnId = null;
        sessionState.lastTokenUsage = null;
        const activePrompt = this.trackActivePrompt(params.sessionId);
        let pendingTurnStart: PendingTurnStart | null = null;

        try {
            const eventHandler = new CodexEventHandler(this.connection, sessionState);
            const approvalHandler = new CodexApprovalHandler(this.connection, sessionState);
            const elicitationHandler = new CodexElicitationHandler(this.connection, sessionState);
            await this.codexAcpClient.subscribeToSessionEvents(params.sessionId,
                (event) => {
                    elicitationHandler.handleNotification(event);
                    return eventHandler.handleNotification(event);
                },
                approvalHandler,
                elicitationHandler);

            if (await this.availableCommands.tryHandleCommand(params.prompt, sessionState)) {
                logger.log("Prompt handled by a command");
                return {
                    stopReason: "end_turn",
                    usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

            if (this.closingSessions.has(params.sessionId)) {
                return {
                    stopReason: "cancelled",
                    usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

            const modelId = ModelId.fromString(sessionState.currentModelId);
            const modelLacksReasoning = sessionState.supportedReasoningEfforts.length > 0
                && sessionState.supportedReasoningEfforts.every(e => e.reasoningEffort === "none");

            const disableSummary = sessionState.account?.type === "apiKey" || modelLacksReasoning;
            if (disableSummary) {
                logger.log("Disable reasoning.summary", {
                    sessionId: params.sessionId,
                    reason: sessionState.account?.type === "apiKey" ? "API key" : "model lacks reasoning"
                });
            }

            if (!sessionState.supportedInputModalities.includes("image") && params.prompt.some(b => b.type === "image")) {
                throw RequestError.invalidRequest("The current model does not support image input");
            }
            const agentMode = sessionState.agentMode;
            const serviceTier = resolveFastServiceTier(
                sessionState.fastModeEnabled,
                sessionState.currentModelSupportsFast,
            );
            pendingTurnStart = this.createPendingTurnStart();
            this.pendingTurnStarts.set(params.sessionId, pendingTurnStart);
            const sendPromptPromise = this.runWithProcessCheck(
                () => this.codexAcpClient.sendPrompt(
                    params,
                    agentMode,
                    modelId,
                    serviceTier,
                    disableSummary,
                    sessionState.cwd,
                    (turnId) => {
                        if (this.promptIsClosedOrStale(params.sessionId, activePrompt)) {
                            this.interruptLateStartedTurn(params.sessionId, turnId);
                            return;
                        }
                        sessionState.currentTurnId = turnId;
                        pendingTurnStart?.resolve(turnId);
                    },
                    () => this.promptIsClosedOrStale(params.sessionId, activePrompt),
                ));
            void sendPromptPromise.catch((err) => {
                if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                    logger.error(`Prompt for closed session ${params.sessionId} failed after close`, err);
                }
            });
            const turnCompleted = await Promise.race([
                sendPromptPromise,
                activePrompt.closeSignal,
            ]);

            if (turnCompleted === null) {
                return {
                    stopReason: "cancelled",
                    usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

            // Check if turn was interrupted (cancelled)
            if (turnCompleted.turn.status === "interrupted") {
                if (!this.closingSessions.has(params.sessionId) && this.sessions.has(params.sessionId)) {
                    await this.connection.sessionUpdate({
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: "*Conversation interrupted*"
                            }
                        }
                    });
                }
                return {
                    stopReason: "cancelled",
                    usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

            const error = eventHandler.getFailure()
            if (error) {
                // noinspection ExceptionCaughtLocallyJS
                throw error;
            }

            return {
                stopReason: "end_turn",
                usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                _meta: this.buildQuotaMeta(sessionState),
            };
        } catch (err) {
            logger.error(`Prompt for session ${params.sessionId} failed`, err);
            throw err;
        } finally {
            logger.log("Prompt completed", {sessionId: params.sessionId});
            sessionState.currentTurnId = null;
            if (pendingTurnStart !== null && this.pendingTurnStarts.get(params.sessionId) === pendingTurnStart) {
                this.pendingTurnStarts.delete(params.sessionId);
            }
            pendingTurnStart?.resolve(null);
            activePrompt.complete();
        }
    }

    private buildQuotaMeta(sessionState: SessionState): { quota: QuotaMeta } {
        const lastTokenUsage = sessionState.lastTokenUsage;

        // Remove the "[reasoning-level]" suffix from currentModelId if present
        const modelName = sessionState.currentModelId.replace(/\[.*?]$/, '');

        // FIXME: currently all tokens are reported for the current model
        const modelUsage = (lastTokenUsage != null)
            ? [{ model: modelName, token_count: lastTokenUsage }]
            : [];

        return {
            quota: {
                token_count: sessionState.lastTokenUsage,
                model_usage: modelUsage
            }
        };
    }

    private buildPromptUsage(lastTokenUsage: TokenCount | null): acp.Usage | null {
        if (lastTokenUsage == null) {
            return null;
        }
        return toPromptUsage(lastTokenUsage);
    }

    private async runWithProcessCheck<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (err) {
            const exitCode = this.getExitCode();
            const requestErrorCode = 1001 // Just some magic number
            if (exitCode == 3221225781) {
                throw new RequestError(requestErrorCode, `VC++ redistributable should be installed`);
            }
            if (exitCode !== null) {
                throw new RequestError(requestErrorCode, `Codex process has exited with code ${exitCode}`);
            }
            throw err;
        }
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) {
            logger.log("Cancel request rejected: session not found", {sessionId: params.sessionId});
            return;
        }

        // After turnInterrupt(), Codex will send turn/completed, which naturally completes awaitTurnCompleted().
        await this.interruptSessionTurn(sessionState, "Cancel", false);
    }
}

function getRequestedMcpServerNames(mcpServers: Array<acp.McpServer>): Array<string> {
    return Array.from(new Set(mcpServers.map(server => server.name)));
}
