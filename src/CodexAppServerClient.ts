import {type MessageConnection, RequestType} from "vscode-jsonrpc/node";
import type {
    ClientRequest,
    InitializeParams,
    InitializeResponse,
    McpStartupCompleteEvent,
    ServerNotification
} from "./app-server";
import type {
    AccountLoginCompletedNotification, AccountUpdatedNotification,
    GetAccountParams,
    GetAccountResponse, LoginAccountParams, LoginAccountResponse, LogoutAccountResponse, ModelListParams,
    ModelListResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadLoadedListParams,
    ThreadLoadedListResponse,
    ThreadListParams,
    ThreadListResponse,
    ThreadReadParams,
    ThreadReadResponse,
    TurnCompletedNotification,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    SkillsListParams,
    SkillsListResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse, ConfigReadParams, ConfigReadResponse,
} from "./app-server/v2";

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
}

export interface ElicitationHandler {
    handleElicitation(params: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse>;
}

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
    private mcpStartupCompleteVersion = 0;
    private lastMcpStartupComplete: McpStartupCompleteEvent | null = null;
    private readonly mcpStartupCompleteResolvers: Array<SignalResolver<McpStartupCompleteEvent>> = [];

    constructor(connection: MessageConnection) {
        this.connection = connection;
        this.connection.onUnhandledNotification((data) => {
            if (isMcpStartupCompleteNotification(data)) {
                this.mcpStartupCompleteVersion += 1;
                this.lastMcpStartupComplete = data.params.msg;
                this.resolveSignal(data.params.msg, this.mcpStartupCompleteVersion, this.mcpStartupCompleteResolvers);
                for (const callback of this.codexEventHandlers) {
                    callback({ eventType: "notification", ...data });
                }
                return;
            }
            const serverNotification = data as ServerNotification;
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

    getMcpStartupCompleteVersion(): number {
        return this.mcpStartupCompleteVersion;
    }

    async awaitMcpStartup(afterVersion: number): Promise<McpStartupCompleteEvent> {
        return await this.awaitSignal(
            this.lastMcpStartupComplete,
            this.mcpStartupCompleteVersion,
            afterVersion,
            this.mcpStartupCompleteResolvers
        );
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

    private resolveSignal<T>(
        event: T,
        version: number,
        resolvers: Array<SignalResolver<T>>
    ): void {
        const pendingResolvers: Array<SignalResolver<T>> = [];
        for (const resolver of resolvers) {
            if (resolver.afterVersion < version) {
                resolver.resolve(event);
            } else {
                pendingResolvers.push(resolver);
            }
        }
        resolvers.splice(0, resolvers.length, ...pendingResolvers);
    }

    private async awaitSignal<T>(
        lastEvent: T | null,
        currentVersion: number,
        afterVersion: number,
        resolvers: Array<SignalResolver<T>>
    ): Promise<T> {
        if (lastEvent !== null && currentVersion > afterVersion) {
            return lastEvent;
        }
        return await new Promise((resolve) => {
            resolvers.push({afterVersion, resolve});
        });
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
    | ({ eventType: "notification" } & (ServerNotification | McpStartupCompleteNotification));

type CodexRequest = DistributiveOmit<ClientRequest, "id">

type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;

type SignalResolver<T> = {
    afterVersion: number;
    resolve: (event: T) => void;
};

type McpStartupCompleteNotification = {
    method: "codex/event/mcp_startup_complete",
    params: {
        msg: McpStartupCompleteEvent & { type: "mcp_startup_complete" }
    }
};

function isMcpStartupCompleteNotification(value: unknown): value is McpStartupCompleteNotification {
    return typeof value === "object"
        && value !== null
        && "method" in value
        && value.method === "codex/event/mcp_startup_complete";
}
