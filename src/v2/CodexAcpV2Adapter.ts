import * as acpV1 from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {CodexAcpServer} from "../CodexAcpServer";

type LegacyAgent = Pick<CodexAcpServer,
    | "initialize"
    | "newSession"
    | "loadSession"
    | "resumeSession"
    | "listSessions"
    | "deleteSession"
    | "closeSession"
    | "setSessionConfigOption"
    | "authenticate"
    | "logout"
    | "listProviders"
    | "setProvider"
    | "disableProvider"
    | "prompt"
    | "cancel"
    | "extMethod"
>;

export function createLegacyClientConnection(connection: acp.AgentContext): Pick<acpV1.AgentContext, "notify" | "request"> {
    return {
        notify: async (method: string, params?: unknown): Promise<void> => {
            if (method === acpV1.methods.client.session.update) {
                await connection.notify(acp.methods.client.session.update, mapSessionUpdateNotification(
                    params as acpV1.SessionNotification,
                ));
                return;
            }
            await connection.notify(method, params);
        },
        request: async (method: string, params?: unknown): Promise<unknown> => {
            if (method === acpV1.methods.client.session.requestPermission) {
                const request = params as acpV1.RequestPermissionRequest;
                return await connection.request(acp.methods.client.session.requestPermission, {
                    sessionId: request.sessionId,
                    title: request.toolCall.title ?? "Permission required",
                    description: permissionDescription(request.toolCall),
                    subject: {
                        type: "tool_call",
                        toolCall: request.toolCall,
                    },
                    options: request.options,
                    _meta: request._meta,
                });
            }
            return await connection.request(method, params);
        },
    } as Pick<acpV1.AgentContext, "notify" | "request">;
}

export class CodexAcpV2Adapter {
    private readonly agent: LegacyAgent;
    private readonly connection: acp.AgentContext;

    constructor(agent: LegacyAgent, connection: acp.AgentContext) {
        this.agent = agent;
        this.connection = connection;
    }

    async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
        const response = await this.agent.initialize({
            protocolVersion: acpV1.PROTOCOL_VERSION,
            clientInfo: params.info,
            ...(params.capabilities == null ? {} : {clientCapabilities: mapClientCapabilities(params.capabilities)}),
            ...(params._meta === undefined ? {} : {_meta: params._meta}),
        } as acpV1.InitializeRequest);
        const capabilities = response.agentCapabilities;
        return compact({
            protocolVersion: acp.PROTOCOL_VERSION,
            info: response.agentInfo ?? {
                name: "@agentclientprotocol/codex-acp",
                version: "unknown",
            },
            capabilities: compact({
                session: compact({
                    prompt: mapPromptCapabilities(capabilities?.promptCapabilities),
                    mcp: mapMcpCapabilities(capabilities?.mcpCapabilities),
                    delete: capabilities?.sessionCapabilities?.delete,
                    additionalDirectories: capabilities?.sessionCapabilities?.additionalDirectories,
                }),
                auth: capabilities?.auth,
                providers: capabilities?.providers,
            }),
            authMethods: response.authMethods,
            _meta: response._meta,
        }) as unknown as acp.InitializeResponse;
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        const response = await this.agent.newSession(params as acpV1.NewSessionRequest);
        return compact({
            sessionId: response.sessionId,
            configOptions: mapConfigOptions(response.configOptions),
            _meta: response._meta,
        }) as acp.NewSessionResponse;
    }

    async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        if (params.replayFrom != null && params.replayFrom.type !== "start") {
            throw acp.RequestError.invalidParams(undefined, `Unsupported replay cursor: ${params.replayFrom.type}`);
        }
        const legacyParams = compact({
            sessionId: params.sessionId,
            cwd: params.cwd,
            additionalDirectories: params.additionalDirectories,
            mcpServers: params.mcpServers as acpV1.McpServer[] | undefined,
            _meta: params._meta,
        }) as acpV1.ResumeSessionRequest;
        const response = params.replayFrom?.type === "start"
            ? await this.agent.loadSession(legacyParams as acpV1.LoadSessionRequest)
            : await this.agent.resumeSession(legacyParams);
        return compact({
            configOptions: mapConfigOptions(response.configOptions),
            _meta: response._meta,
        }) as acp.ResumeSessionResponse;
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        return await this.agent.listSessions(params as acpV1.ListSessionsRequest) as acp.ListSessionsResponse;
    }

    async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        return await this.agent.deleteSession(params as acpV1.DeleteSessionRequest);
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        return await this.agent.closeSession(params as acpV1.CloseSessionRequest);
    }

    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        const response = await this.agent.setSessionConfigOption(params as acpV1.SetSessionConfigOptionRequest);
        return compact({
            configOptions: mapConfigOptions(response.configOptions) ?? [],
            _meta: response._meta,
        }) as acp.SetSessionConfigOptionResponse;
    }

    async login(params: acp.LoginAuthRequest, requestId?: acp.JsonRpcId): Promise<acp.LoginAuthResponse> {
        return await this.agent.authenticate(params as acpV1.AuthenticateRequest, requestId);
    }

    async logout(params: acp.LogoutAuthRequest): Promise<acp.LogoutAuthResponse> {
        await this.agent.logout(params as acpV1.LogoutRequest);
        return {};
    }

    listProviders(params: acp.ListProvidersRequest): acp.ListProvidersResponse {
        return this.agent.listProviders(params as acpV1.ListProvidersRequest) as acp.ListProvidersResponse;
    }

    async setProvider(params: acp.SetProviderRequest): Promise<acp.SetProviderResponse> {
        return await this.agent.setProvider(params as acpV1.SetProviderRequest) as acp.SetProviderResponse;
    }

    async disableProvider(params: acp.DisableProviderRequest): Promise<acp.DisableProviderResponse> {
        return await this.agent.disableProvider(params as acpV1.DisableProviderRequest) as acp.DisableProviderResponse;
    }

    async prompt(params: acp.PromptRequest, signal?: AbortSignal): Promise<acp.PromptResponse> {
        await this.updateState(params.sessionId, "running");
        void this.agent.prompt(params as acpV1.PromptRequest, signal)
            .then(async (response) => {
                await this.connection.notify(acp.methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "idle",
                        stopReason: response.stopReason,
                        usage: response.usage,
                    },
                });
            })
            .catch(async (error: unknown) => {
                await this.connection.notify(acp.methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "idle",
                        stopReason: "refusal",
                        _meta: {
                            error: error instanceof Error ? error.message : String(error),
                        },
                    },
                });
            });
        return {};
    }

    async cancel(params: acp.CancelSessionNotification): Promise<void> {
        await this.agent.cancel(params as acpV1.CancelNotification);
    }

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        return await this.agent.extMethod(method, params);
    }

    private async updateState(sessionId: string, state: "running"): Promise<void> {
        await this.connection.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
                sessionUpdate: "state_update",
                state,
            },
        });
    }
}

export function mapSessionUpdateNotification(notification: acpV1.SessionNotification): acp.UpdateSessionNotification {
    const update = notification.update;
    switch (update.sessionUpdate) {
        case "tool_call":
            return {
                ...notification,
                update: {
                    ...update,
                    sessionUpdate: "tool_call_update",
                },
            } as acp.UpdateSessionNotification;
        case "plan":
            return {
                ...notification,
                update: {
                    sessionUpdate: "plan_update",
                    plan: {
                        type: "items",
                        planId: "default",
                        entries: update.entries,
                    },
                },
            };
        case "config_option_update":
            return {
                ...notification,
                update: {
                    ...update,
                    sessionUpdate: "config_option_update",
                    configOptions: mapConfigOptions(update.configOptions) ?? [],
                },
            };
        case "current_mode_update":
            return {
                ...notification,
                update: {
                    ...update,
                    sessionUpdate: "_codex/current_mode_update",
                },
            } as acp.UpdateSessionNotification;
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
        case "tool_call_update":
        case "plan_update":
        case "plan_removed":
        case "available_commands_update":
        case "session_info_update":
        case "usage_update":
            return notification as unknown as acp.UpdateSessionNotification;
    }
}

function mapClientCapabilities(capabilities: acp.ClientCapabilities): acpV1.ClientCapabilities {
    return compact({
        elicitation: capabilities.elicitation,
        _meta: capabilities._meta,
        plan: {},
        session: {
            configOptions: {
                boolean: {},
            },
        },
    }) as acpV1.ClientCapabilities;
}

function mapPromptCapabilities(capabilities?: acpV1.PromptCapabilities): acp.PromptCapabilities | undefined {
    if (capabilities == null) {
        return undefined;
    }
    return compact({
        image: capabilities.image ? {} : undefined,
        audio: capabilities.audio ? {} : undefined,
        embeddedContext: capabilities.embeddedContext ? {} : undefined,
        _meta: capabilities._meta,
    }) as acp.PromptCapabilities;
}

function mapMcpCapabilities(capabilities?: acpV1.McpCapabilities): acp.McpCapabilities | undefined {
    if (capabilities == null) {
        return undefined;
    }
    return compact({
        stdio: {},
        http: capabilities.http ? {} : undefined,
        acp: capabilities.acp ? {} : undefined,
        _meta: capabilities._meta,
    }) as acp.McpCapabilities;
}

function mapConfigOptions(options?: acpV1.SessionConfigOption[] | null): acp.SessionConfigOption[] | undefined {
    return options?.map((option) => {
        const {id, ...rest} = option;
        return {
            ...rest,
            configId: id,
        } as acp.SessionConfigOption;
    }) ?? undefined;
}

function permissionDescription(toolCall: acpV1.ToolCallUpdate): string | null {
    if (typeof toolCall.rawInput === "string") {
        return toolCall.rawInput;
    }
    if (toolCall.rawInput != null) {
        return JSON.stringify(toolCall.rawInput);
    }
    return null;
}

function compact<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as T;
}
