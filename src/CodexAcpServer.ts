import * as acp from "@agentclientprotocol/sdk";
import {CodexEventHandler} from "./CodexEventHandler";
import {CodexApprovalHandler} from "./CodexApprovalHandler";
import {CodexAuthMethods, type CodexAuthRequest} from "./CodexAuthMethod";
import {type ModelInfo, RequestError, type SessionModelState} from "@agentclientprotocol/sdk";
import {CodexAcpClient, type SessionMetadata} from "./CodexAcpClient";
import type {Model} from "./app-server/v2";
import type {ReasoningEffort} from "./app-server";
import {ModelId} from "./ModelId";


export interface SessionState {
    sessionMetadata: SessionMetadata;
    currentTurnId: string | null;
}

export class CodexAcpServer implements acp.Agent {
    private readonly codexAcpClient: CodexAcpClient;
    private readonly connection: acp.AgentSideConnection;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;

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
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize(_params));
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: false,
            },
            authMethods: CodexAuthMethods,
        };
    }

    async newSession(
        _params: acp.NewSessionRequest,
    ): Promise<acp.NewSessionResponse> {
        if (await this.runWithProcessCheck(() => this.codexAcpClient.authRequired())) {
            if (this.defaultAuthRequest) {
                await this.authenticate(this.defaultAuthRequest)
            } else {
                throw RequestError.authRequired();
            }
        }

        const sessionMetadata = await this.runWithProcessCheck(() => this.codexAcpClient.newSession(_params));
        const {sessionId, currentModelId, models} = sessionMetadata;
        this.sessions.set(sessionId, {
            sessionMetadata: sessionMetadata,
            currentTurnId: null
        });

        const availableModels = this.buildAvailableModels(models);
        const sessionModelState: SessionModelState = {
            availableModels: availableModels,
            currentModelId: currentModelId,
        }
        return {
            sessionId: sessionId,
            models: sessionModelState,
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
    ): Promise<acp.AuthenticateResponse> {
        const isAuthenticated = await this.runWithProcessCheck(() => this.codexAcpClient.authenticate(_params));
        if (!isAuthenticated) {
            throw RequestError.invalidParams();
        }
        return { };
    }

    async setSessionMode(
        _params: acp.SetSessionModeRequest,
    ): Promise<acp.SetSessionModeResponse> {
        //TODO
        return {};
    }

    async setSessionModel(params: acp.SetSessionModelRequest): Promise<acp.SetSessionModelResponse> {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        const requestedModelId= ModelId.fromString(params.modelId);
        const requestedModelName = requestedModelId.model;
        const requestedEffort = requestedModelId.effort;

        const model = sessionState.sessionMetadata.models.find(m => m.id === requestedModelName);
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


        await this.runWithProcessCheck(() => this.codexAcpClient.setModel({
            model: model.model,
            reasoningEffort,
        }));
        sessionState.sessionMetadata.currentModelId = ModelId.fromComponents(model, reasoningEffort).toString();

        return {};
    }



    private buildAvailableModels(models: Model[]): ModelInfo[] {
        return models.flatMap((model) =>
            model.supportedReasoningEfforts.map((effort) => ({
                modelId: ModelId.fromComponents(model, effort.reasoningEffort).toString(),
                name: `${model.displayName} (${effort.reasoningEffort})`,
                description: `${model.description} ${effort.description}`,
            }))
        );
    }

    getSessionState(sessionId: string): SessionState {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) {
            throw new Error(`Session ${sessionId} not found`);
        }
        return sessionState;
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const sessionState = this.getSessionState(params.sessionId);

        sessionState.currentTurnId = null;

        try {
            const eventHandler = new CodexEventHandler(this.connection, sessionState);
            const approvalHandler = new CodexApprovalHandler(this.connection, sessionState);
            const turnCompleted = await this.runWithProcessCheck(() => this.codexAcpClient.sendPrompt(
                params,
                (event) => eventHandler.handleNotification(event),
                approvalHandler
            ));
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
                };
            }

            return {
                stopReason: "end_turn",
            };
        } catch (err) {
            console.error(`Prompt for session ${params.sessionId} failed:`, err);
            throw err;
        } finally {
            sessionState.currentTurnId = null;
        }
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
            console.info(`Can not cancel: session ${params.sessionId} not found`);
            return;
        }

        if (!sessionState.currentTurnId) {
            console.info(`Can not cancel: session ${params.sessionId} has no current turn`);
            return;
        }

        console.info(`Cancel session ${params.sessionId}, currentTurnId: ${sessionState.currentTurnId}...`);
        try {
            // After turnInterrupt(), Codex will send turn/completed event, which will naturally complete awaitTurnCompleted()
            await this.codexAcpClient.turnInterrupt({
                threadId: params.sessionId,
                turnId: sessionState.currentTurnId
            });
            console.log(`Cancel - turnInterrupt succeeded`);
        } catch (err) {
            console.error(`Cancel - turnInterrupt failed:`, err);
        }
    }
}