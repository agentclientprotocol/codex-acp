import * as acp from "@agentclientprotocol/sdk";
import {
    type ModelInfo,
    RequestError,
    type SessionId,
    type SessionModelState,
    type SessionModeState
} from "@agentclientprotocol/sdk";
import {CodexEventHandler} from "./CodexEventHandler";
import {CodexApprovalHandler} from "./CodexApprovalHandler";
import {CodexAuthMethods, type CodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient, type SessionMetadata} from "./CodexAcpClient";
import type {Account, Model, RateLimitSnapshot} from "./app-server/v2";
import type {ReasoningEffort} from "./app-server";
import {ModelId} from "./ModelId";
import {AgentMode} from "./AgentMode";
import type {TokenCount} from "./TokenCount";
import {CodexCommands} from "./CodexCommands";
import type {QuotaMeta} from "./QuotaMeta";
import {logger} from "./Logger";

const ALLOWED_MODEL_IDS = new Set([
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
]);

export interface SessionState {
    sessionId: string,
    currentModelId: string,
    agentMode: AgentMode,
    currentTurnId: string | null;
    lastTokenUsage: TokenCount | null;
    totalTokenUsage: TokenCount | null;
    modelContextWindow: number | null;
    rateLimits: RateLimitSnapshot | null;
    account: Account | null;
    cwd: string;
}

export class CodexAcpServer implements acp.Agent {
    private readonly codexAcpClient: CodexAcpClient;
    private readonly connection: acp.AgentSideConnection;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;
    private readonly availableCommands: CodexCommands;

    private readonly sessions: Map<string, SessionState>;

    constructor(
        connection: acp.AgentSideConnection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
        getExitCode?: () => number | null,
    ) {
        this.sessions = new Map();
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
            agentCapabilities: {
                loadSession: false,
                promptCapabilities: {
                    image: true
                },
                sessionCapabilities: {
                    resume: { }
                }
            },
            authMethods: CodexAuthMethods,
        };
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
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            agentMode: AgentMode.getInitialAgentMode(),
            currentTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: accountResponse.account,
            cwd: request.cwd,
        }
        this.sessions.set(sessionId, sessionState);

        this.publishAvailableCommandsAsync(sessionId);
        const sessionModelState: SessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState = sessionState.agentMode.toSessionModeState();

        return [sessionId, sessionModelState, sessionModeState];
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

        return {};
    }

    private publishAvailableCommandsAsync(sessionId: string) {
        void this.availableCommands.publish(sessionId);
    }

    private createModelState(availableModels: Model[], selectedModelId: string): SessionModelState {
        const allowedModels = availableModels
            .filter((model) => ALLOWED_MODEL_IDS.has(model.id))
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

    getSessionState(sessionId: string): SessionState {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) {
            throw new Error(`Session ${sessionId} not found`);
        }
        return sessionState;
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

            const disableSummary = sessionState.account?.type === "apiKey"
            if (disableSummary) {
                logger.log("Disable reasoning.summary because API key is used", {sessionId: params.sessionId});
            }


            const agentMode = sessionState.agentMode;
            const modelId = ModelId.fromString(sessionState.currentModelId);
            const turnCompleted = await this.runWithProcessCheck(
                () => this.codexAcpClient.sendPrompt(params, agentMode, modelId, disableSummary));

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
