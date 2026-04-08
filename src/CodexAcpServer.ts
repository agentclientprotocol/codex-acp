import * as acp from "@agentclientprotocol/sdk";
import {
    RequestError,
    type SessionId,
    type SessionModelState,
    type SessionModeState
} from "@agentclientprotocol/sdk";
import {CodexEventHandler} from "./CodexEventHandler";
import {CodexApprovalHandler} from "./CodexApprovalHandler";
import {CodexAuthMethods, type CodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient, type SessionMetadata, type SessionMetadataWithThread} from "./CodexAcpClient";
import {ACPSessionConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {McpStartupCompleteEvent, InputModality, ReasoningEffort} from "./app-server";
import type {
    Account,
    CollabAgentToolCallStatus,
    McpServerStatusUpdatedNotification,
    Model,
    Thread,
    ThreadItem,
    UserInput,
    ReasoningEffortOption
} from "./app-server/v2";
import type {RateLimitsMap} from "./RateLimitsMap";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import type {TokenCount} from "./TokenCount";
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
    sessionMcpServers?: Array<string>;
}

interface PendingMcpStartupSession {
    requestedServers: Set<string>;
    terminalServers: Set<string>;
    publishedFailures: Set<string>;
}

export class CodexAcpServer implements acp.Agent {
    private readonly codexAcpClient: CodexAcpClient;
    private readonly connection: acp.AgentSideConnection;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;
    private readonly availableCommands: CodexCommands;

    private readonly sessions: Map<string, SessionState>;
    private readonly pendingMcpStartupSessions: Map<string, PendingMcpStartupSession>;

    constructor(
        connection: acp.AgentSideConnection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
        getExitCode?: () => number | null,
    ) {
        this.sessions = new Map();
        this.pendingMcpStartupSessions = new Map();
        this.connection = connection;
        this.codexAcpClient = codexAcpClient;
        this.defaultAuthRequest = defaultAuthRequest ?? null;
        this.getExitCode = getExitCode ?? (() => null);
        this.availableCommands = new CodexCommands(
            connection,
            codexAcpClient,
            (operation) => this.runWithProcessCheck(operation)
        );
        this.codexAcpClient.onMcpServerStatusUpdated((event) => {
            void this.handleMcpServerStatusUpdated(event);
        });
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        logger.log("Initialize request received");
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize(_params));
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: {
                    image: true
                },
                sessionCapabilities: {
                    resume: { },
                    list: { }
                },
                mcpCapabilities: {
                    http: true,
                    sse: false
                }
            },
            authMethods: CodexAuthMethods,
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
            case "authentication/logout":
                return await this.runWithProcessCheck(() => this.codexAcpClient.logout());
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
        await this.checkAuthorization();
        const mcpStartupVersion = this.codexAcpClient.getMcpStartupCompleteVersion();
        const mcpStatusVersion = this.codexAcpClient.getMcpServerStatusVersion();

        let sessionMetadata: SessionMetadata;
        if ("sessionId" in request) {
            logger.log(`Resume existing session: ${request.sessionId}...`)
            sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.resumeSession(request));
        } else {
            logger.log(`Create new session...`)
            sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.newSession(request));
        }

        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        const {sessionId, currentModelId, models} = sessionMetadata;
        const sessionMcpServers = await this.resolveSessionMcpServers(request.mcpServers ?? [], mcpStartupVersion, "sessionId" in request);
        const currentModel = this.findCurrentModel(models, currentModelId);
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
            account: accountResponse.account,
            cwd: request.cwd,
            sessionMcpServers: sessionMcpServers,
        }
        this.sessions.set(sessionId, sessionState);

        const requestedMcpServers = request.mcpServers ?? [];
        if (requestedMcpServers.length > 0) {
            this.pendingMcpStartupSessions.set(sessionId, {
                requestedServers: new Set(requestedMcpServers.map(server => server.name)),
                terminalServers: new Set(),
                publishedFailures: new Set(),
            });
            await this.replayBufferedMcpStartupStatus(sessionId, mcpStatusVersion);
            this.publishMcpStartupStatusAsync(sessionId, mcpStartupVersion);
        }

        this.publishAvailableCommandsAsync(sessionId);
        const sessionModelState: SessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState = sessionState.agentMode.toSessionModeState();

        return [sessionId, sessionModelState, sessionModeState];
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
            modes: modeState
        };
    }

    async unstable_resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        logger.log("Resuming session...", {sessionId: params.sessionId});
        const [sessionId, modelState, modeState] = await this.getOrCreateSession(params);

        logger.log("Session resumed", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState
        };
    }

    async unstable_listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        logger.log("Listing sessions...", {cwd: params.cwd, cursor: params.cursor});
        await this.checkAuthorization();
        return await this.runWithProcessCheck(() => this.codexAcpClient.listSessions(params));
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
            modes: modeState
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

        return {};
    }

    private publishAvailableCommandsAsync(sessionId: string) {
        void this.availableCommands.publish(sessionId);
    }

    private findCurrentModel(models: Model[], currentModelId: string): Model | undefined {
        const modelId = ModelId.fromString(currentModelId);
        return models.find(m => m.id === modelId.model);
    }

    private createModelState(availableModels: Model[], selectedModelId: string): SessionModelState {
        const allowedModels = availableModels
            .flatMap((model) =>
                model.supportedReasoningEfforts.map((effort) => ({
                    modelId: ModelId.fromComponents(model, effort.reasoningEffort).toString(),
                    name: `${model.displayName} (${effort.reasoningEffort})`,
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
        await this.checkAuthorization();
        const mcpStartupVersion = this.codexAcpClient.getMcpStartupCompleteVersion();

        logger.log(`Load existing session: ${request.sessionId}...`);
        const sessionMetadata: SessionMetadataWithThread = await this.runWithProcessCheck(() =>
            this.codexAcpClient.loadSession(request)
        );

        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        const {sessionId, currentModelId, models, thread} = sessionMetadata;
        const sessionMcpServers = await this.resolveSessionMcpServers(request.mcpServers ?? [], mcpStartupVersion, true);
        const currentModel = this.findCurrentModel(models, currentModelId);
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
            account: accountResponse.account,
            cwd: request.cwd,
            sessionMcpServers: sessionMcpServers,
        };
        this.sessions.set(sessionId, sessionState);

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

    private async resolveSessionMcpServers(
        mcpServers: Array<acp.McpServer>,
        mcpStartupVersion: number,
        recoverFromStartup: boolean,
    ): Promise<Array<string>> {
        // Explicit MCP servers from the request are the primary source of truth for the session.
        const requestedServerNames = getRequestedMcpServerNames(mcpServers);
        if (requestedServerNames.length > 0) {
            return requestedServerNames;
        }
        // Fresh sessions without MCP config should not inherit any session MCP state.
        if (!recoverFromStartup) {
            return [];
        }
        // loadSession/resumeSession may omit mcpServers; in that case recover the ready names
        // from the startup event associated with this thread start/resume checkpoint.
        logger.log("Recovering MCP servers from startup state...");
        return await this.runWithProcessCheck(() => this.codexAcpClient.awaitMcpStartup(mcpStartupVersion));
    }

    private publishMcpStartupStatusAsync(sessionId: string, mcpStartupVersion: number): void {
        void (async () => {
            try {
                const mcpStartup = await this.runWithProcessCheck(() => this.codexAcpClient.awaitMcpStartupResult(mcpStartupVersion));
                const sessionState = this.sessions.get(sessionId);
                if (sessionState) {
                    sessionState.sessionMcpServers = mcpStartup.ready;
                }
                await this.publishMcpStartupStatus(sessionId, mcpStartup);
                this.pendingMcpStartupSessions.delete(sessionId);
            } catch (err) {
                logger.error(`Failed to publish MCP startup status for session ${sessionId}`, err);
            }
        })();
    }

    private async publishMcpStartupStatus(sessionId: string, mcpStartup: McpStartupCompleteEvent): Promise<void> {
        for (const update of CodexEventHandler.createMcpStartupUpdates(mcpStartup)) {
            await this.connection.sessionUpdate({
                sessionId,
                update,
            });
        }
    }

    private async handleMcpServerStatusUpdated(event: McpServerStatusUpdatedNotification): Promise<void> {
        for (const [sessionId, pending] of this.pendingMcpStartupSessions) {
            if (!pending.requestedServers.has(event.name)) {
                continue;
            }

            if (event.status === "ready") {
                pending.terminalServers.add(event.name);
                const sessionState = this.sessions.get(sessionId);
                if (sessionState && !(sessionState.sessionMcpServers ?? []).includes(event.name)) {
                    sessionState.sessionMcpServers = [...(sessionState.sessionMcpServers ?? []), event.name];
                }
            } else if (event.status === "failed" || event.status === "cancelled") {
                pending.terminalServers.add(event.name);
                if (!pending.publishedFailures.has(event.name)) {
                    pending.publishedFailures.add(event.name);
                    const updates = CodexEventHandler.createMcpStartupUpdates({
                        ready: [],
                        failed: event.status === "failed" ? [{
                            server: event.name,
                            error: event.error ?? "Unknown MCP startup error",
                        }] : [],
                        cancelled: event.status === "cancelled" ? [event.name] : [],
                    });
                    for (const update of updates) {
                        await this.connection.sessionUpdate({
                            sessionId,
                            update,
                        });
                    }
                }
            }

            if (pending.terminalServers.size >= pending.requestedServers.size) {
                this.pendingMcpStartupSessions.delete(sessionId);
            }
        }
    }

    private async replayBufferedMcpStartupStatus(sessionId: string, afterVersion: number): Promise<void> {
        const updates = this.codexAcpClient.getMcpServerStatusUpdates(afterVersion);
        for (const update of updates) {
            await this.handleMcpServerStatusUpdated(update);
            if (!this.pendingMcpStartupSessions.has(sessionId)) {
                return;
            }
        }
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        logger.log("Prompt received", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        sessionState.currentTurnId = null;
        sessionState.lastTokenUsage = null;

        try {
            const eventHandler = new CodexEventHandler(this.connection, sessionState);
            const approvalHandler = new CodexApprovalHandler(this.connection, sessionState);
            await this.codexAcpClient.subscribeToSessionEvents(params.sessionId,
                (event) => eventHandler.handleNotification(event),
                approvalHandler);

            if (await this.availableCommands.tryHandle(params.prompt, sessionState)) {
                logger.log("Prompt handled by a command");
                return {
                    stopReason: "end_turn",
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
            const turnCompleted = await this.runWithProcessCheck(
                () => this.codexAcpClient.sendPrompt(params, agentMode, modelId, disableSummary, sessionState.cwd));

            // Check if turn was interrupted (cancelled)
            if (turnCompleted.turn.status === "interrupted") {
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
                return {
                    stopReason: "cancelled",
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
                _meta: this.buildQuotaMeta(sessionState),
            };
        } catch (err) {
            logger.error(`Prompt for session ${params.sessionId} failed`, err);
            throw err;
        } finally {
            logger.log("Prompt completed", {sessionId: params.sessionId});
            sessionState.currentTurnId = null;
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

        if (!sessionState.currentTurnId) {
            logger.log("Cancel request rejected: no current turn", {sessionId: params.sessionId});
            return;
        }

        logger.log("Cancel session requested", {
            sessionId: params.sessionId,
            currentTurnId: sessionState.currentTurnId
        });
        try {
            // After turnInterrupt(), Codex will send turn/completed event, which will naturally complete awaitTurnCompleted()
            await this.codexAcpClient.turnInterrupt({
                threadId: params.sessionId,
                turnId: sessionState.currentTurnId
            });
            logger.log("Cancel - turnInterrupt succeeded", {
                sessionId: params.sessionId,
                currentTurnId: sessionState.currentTurnId
            });
        } catch (err) {
            logger.error(`Cancel - turnInterrupt failed`, err);
        }
    }
}

function getRequestedMcpServerNames(mcpServers: Array<acp.McpServer>): Array<string> {
    return Array.from(new Set(mcpServers.map(server => server.name)));
}
