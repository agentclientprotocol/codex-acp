import * as acp from "@agentclientprotocol/sdk";
import {CodexEventHandler} from "./CodexEventHandler";
import {CodexAuthMethods, type CodexAuthRequest} from "./CodexAuthMethod";
import {RequestError} from "@agentclientprotocol/sdk";
import {CodexAcpClient} from "./CodexAcpClient";


export interface SessionState {
    sessionId: string,
    pendingPrompt: AbortController | null;
}

export class CodexACPAgent implements acp.Agent {
    private readonly codexAcpClient: CodexAcpClient;
    private readonly connection: acp.AgentSideConnection;
    private readonly defaultAuthRequest: CodexAuthRequest | null;

    private readonly sessions: Map<string, SessionState>;

    constructor(
        connection: acp.AgentSideConnection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
    ) {
        this.sessions = new Map();
        this.connection = connection;
        this.defaultAuthRequest = defaultAuthRequest ?? null;
        this.codexAcpClient = codexAcpClient;
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        await this.codexAcpClient.initialize(_params);
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
        if (await this.codexAcpClient.authRequired()) {
            if (this.defaultAuthRequest) {
                await this.authenticate(this.defaultAuthRequest)
            } else {
                throw RequestError.authRequired();
            }
        }

        const sessionId = await this.codexAcpClient.newSession(_params);
        this.sessions.set(sessionId, {
            sessionId: sessionId,
            pendingPrompt: null,
        });

        return {
            sessionId: sessionId,
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
    ): Promise<acp.AuthenticateResponse> {
        const isAuthenticated = await this.codexAcpClient.authenticate(_params);
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

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) {
            throw new Error(`Session ${params.sessionId} not found`);
        }

        sessionState.pendingPrompt?.abort();
        sessionState.pendingPrompt = new AbortController();

        try {
            const messageHandler = new CodexEventHandler(this.connection, sessionState);
            await this.codexAcpClient.sendPrompt(params, (event) => messageHandler.handleNotification(event));
        } catch (err) {
            if (sessionState.pendingPrompt.signal.aborted) {
                return {stopReason: "cancelled"};
            }

            throw err;
        }

        sessionState.pendingPrompt = null;

        return {
            stopReason: "end_turn",
        };
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        //TODO not supported yet
        this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
    }
}