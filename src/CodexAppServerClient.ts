import {type MessageConnection, RequestType} from "vscode-jsonrpc/node";
import type {
    ClientRequest,
    InitializeParams,
    InitializeResponse,
    ServerNotification
} from "./app-server";
import type {
    AccountLoginCompletedNotification, AccountUpdatedNotification,
    ConfigReadParams,
    ConfigReadResponse,
    GetAccountParams,
    GetAccountResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    LoginAccountParams,
    LoginAccountResponse,
    LogoutAccountResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    McpServerStartupState,
    McpServerStatusUpdatedNotification,
    ModelListParams,
    ModelListResponse,
    SkillsListParams,
    SkillsListResponse,
    ThreadLoadedListParams,
    ThreadLoadedListResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadStartParams,
    ThreadStartResponse,
    TurnCompletedNotification,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
} from "./app-server/v2";

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
}

export interface ElicitationHandler {
    handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse>;
}

export type McpStartupFailure = {
    server: string;
    error: string;
};

export type McpStartupResult = {
    ready: Array<string>;
    failed: Array<McpStartupFailure>;
    cancelled: Array<string>;
};

const CommandExecutionApprovalRequest = new RequestType<
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    void
>('item/commandExecution/requestApproval');

const FileChangeApprovalRequest = new RequestType<
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    void
>('item/fileChange/requestApproval');

const McpServerElicitationRequest = new RequestType<
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    void
>('mcpServer/elicitation/request');

/**
 * A type-safe client over the Codex App Server's JSON-RPC API.
 * Maps each request to its expected response and exposes clear, typed methods for supported JSON-RPC operations.
 */
export class CodexAppServerClient {
    readonly connection: MessageConnection;
    private approvalHandlers = new Map<string, ApprovalHandler>();
    private elicitationHandlers = new Map<string, ElicitationHandler>();
    private mcpServerStartupVersion = 0;
    private readonly mcpServerStartupStates = new Map<string, McpServerStartupSnapshot>();
    private readonly mcpServerStartupResolvers: Array<McpServerStartupResolver> = [];

    constructor(connection: MessageConnection) {
        this.connection = connection;
        this.connection.onUnhandledNotification((data) => {
            const serverNotification = data as ServerNotification;
            if (isMcpServerStatusUpdatedNotification(serverNotification)) {
                this.mcpServerStartupVersion += 1;
                this.mcpServerStartupStates.set(serverNotification.params.name, {
                    status: serverNotification.params.status,
                    error: serverNotification.params.error,
                    version: this.mcpServerStartupVersion,
                });
                this.resolveMcpServerStartupResolvers();
            }
            this.notify(serverNotification);
            for (const callback of this.codexEventHandlers) {
                callback({ eventType: "notification", ...serverNotification });
            }
        });

        this.connection.onRequest(CommandExecutionApprovalRequest, async (params) => {
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleCommandExecution(params);
        });

        this.connection.onRequest(FileChangeApprovalRequest, async (params) => {
            const handler = this.approvalHandlers.get(params.threadId);
            if (!handler) {
                return { decision: "cancel" };
            }
            return await handler.handleFileChange(params);
        });

        this.connection.onRequest(McpServerElicitationRequest, async (params) => {
            const handler = this.elicitationHandlers.get(params.threadId);
            if (!handler) {
                return { action: "cancel", content: null, _meta: null };
            }
            return await handler.handleElicitation(params);
        });
    }

    onApprovalRequest(threadId: string, handler: ApprovalHandler): void {
        this.approvalHandlers.set(threadId, handler);
    }

    onElicitationRequest(threadId: string, handler: ElicitationHandler): void {
        this.elicitationHandlers.set(threadId, handler);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        return await this.sendRequest({ method: "initialize", params: params });
    }

    async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
        return await this.sendRequest({ method: "turn/start", params: params });
    }

    async turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        return await this.sendRequest({ method: "turn/interrupt", params: params });
    }

    async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
        return await this.sendRequest({ method: "thread/start", params: params });
    }

    async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
        return await this.sendRequest({ method: "thread/resume", params: params });
    }

    async threadList(params: ThreadListParams): Promise<ThreadListResponse> {
        return await this.sendRequest({ method: "thread/list", params: params });
    }

    async threadLoadedList(params: ThreadLoadedListParams): Promise<ThreadLoadedListResponse> {
        return await this.sendRequest({ method: "thread/loaded/list", params: params });
    }

    async threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> {
        return await this.sendRequest({ method: "thread/read", params: params });
    }

    async listMcpServerStatus(params: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse> {
        return await this.sendRequest({ method: "mcpServerStatus/list", params });
    }

    async accountLogin(params: LoginAccountParams): Promise<LoginAccountResponse> {
        return await this.sendRequest({ method: "account/login/start", params: params });
    }

    async accountLogout(): Promise<LogoutAccountResponse> {
        return await this.sendRequest({ method: "account/logout", params: undefined });
    }

    async configRead(params: ConfigReadParams): Promise<ConfigReadResponse> {
        return await this.sendRequest({ method: "config/read", params: params });
    }

    getMcpServerStartupVersion(): number {
        return this.mcpServerStartupVersion;
    }

    async awaitMcpServerStartup(serverNames: Array<string>, afterVersion: number): Promise<McpStartupResult> {
        const uniqueServerNames = Array.from(new Set(serverNames.map(serverName => serverName.trim()).filter(serverName => serverName.length > 0)));
        if (uniqueServerNames.length === 0) {
            return { ready: [], failed: [], cancelled: [] };
        }

        const result = this.tryBuildMcpStartupResult(uniqueServerNames, afterVersion);
        if (result !== null) {
            return result;
        }

        return await new Promise((resolve) => {
            this.mcpServerStartupResolvers.push({
                serverNames: uniqueServerNames,
                afterVersion,
                resolve,
            });
        });
    }

    async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return await this.sendRequest({ method: "account/read", params: params });
    }

    //TODO create type-safe helper
    async awaitTurnCompleted(): Promise<TurnCompletedNotification> {
        return await new Promise((resolve) => {
            this.connection.onNotification("turn/completed", (event: TurnCompletedNotification) => {
                resolve(event);
            });
        });
    }

    async listModels(params: ModelListParams = {cursor: null, limit: null}): Promise<ModelListResponse> {
        return await this.sendRequest({ method: "model/list", params });
    }

    async listSkills(params: SkillsListParams = {}): Promise<SkillsListResponse> {
        return await this.sendRequest({ method: "skills/list", params });
    }

    /**
     * Registers a notification handler for a specific session.
     * Replaces any existing handler for the same session, preventing handler accumulation.
     */
    onServerNotification(sessionId: string, callback: (event: ServerNotification) => void) {
        this.notificationHandlers.set(sessionId, callback);
    }

    private codexEventHandlers: Array<(event: CodexConnectionEvent) => void> = [];
    onClientTransportEvent(callback: (event: CodexConnectionEvent) => void){
        this.codexEventHandlers.push(callback);
    }

    private notificationHandlers = new Map<string, (event: ServerNotification) => void>();
    private notify(notification: ServerNotification) {
        for (const notificationHandler of this.notificationHandlers.values()) {
            notificationHandler(notification);
        }
    }

    private resolveMcpServerStartupResolvers(): void {
        const pendingResolvers: Array<McpServerStartupResolver> = [];
        for (const resolver of this.mcpServerStartupResolvers) {
            const result = this.tryBuildMcpStartupResult(resolver.serverNames, resolver.afterVersion);
            if (result !== null) {
                resolver.resolve(result);
            } else {
                pendingResolvers.push(resolver);
            }
        }
        this.mcpServerStartupResolvers.splice(0, this.mcpServerStartupResolvers.length, ...pendingResolvers);
    }

    private tryBuildMcpStartupResult(serverNames: Array<string>, afterVersion: number): McpStartupResult | null {
        const ready: Array<string> = [];
        const failed: Array<McpStartupFailure> = [];
        const cancelled: Array<string> = [];

        for (const serverName of serverNames) {
            const state = this.mcpServerStartupStates.get(serverName);
            if (!state || state.version <= afterVersion) {
                return null;
            }

            switch (state.status) {
                case "starting":
                    return null;
                case "ready":
                    ready.push(serverName);
                    break;
                case "failed":
                    failed.push({
                        server: serverName,
                        error: state.error ?? "unknown MCP startup error",
                    });
                    break;
                case "cancelled":
                    cancelled.push(serverName);
                    break;
            }
        }

        return { ready, failed, cancelled };
    }

    private async sendRequest<R>(request: CodexRequest): Promise<R> {
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "request", ...request});
        }
        let result: any;
        if (request.params) {
            result = await this.connection.sendRequest<R>(request.method, request.params)
        }
        else {
            result = await this.connection.sendRequest<R>(request.method);
        }
        for (const callback of this.codexEventHandlers) {
            callback({ eventType: "response", ...result});
        }
        return result;
    }
}

export type CodexConnectionEvent =
    | ({ eventType: "request" } & CodexRequest)
    | ({ eventType: "response" } & unknown)
    | ({ eventType: "notification" } & ServerNotification);

type CodexRequest = DistributiveOmit<ClientRequest, "id">

type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;

type McpServerStartupSnapshot = {
    status: McpServerStartupState;
    error: string | null;
    version: number;
};

type McpServerStartupResolver = {
    serverNames: Array<string>;
    afterVersion: number;
    resolve: (result: McpStartupResult) => void;
};

function isMcpServerStatusUpdatedNotification(notification: ServerNotification): notification is {
    method: "mcpServer/startupStatus/updated";
    params: McpServerStatusUpdatedNotification;
} {
    return notification.method === "mcpServer/startupStatus/updated";
}
