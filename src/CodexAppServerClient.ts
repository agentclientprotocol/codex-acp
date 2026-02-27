import {type MessageConnection, RequestType} from "vscode-jsonrpc/node";
import type {
    ClientRequest, ConversationId,
    InitializeParams,
    InitializeResponse, McpStartupCompleteEvent,
    ServerNotification, SetDefaultModelParams, SetDefaultModelResponse
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
    ThreadForkParams,
    ThreadForkResponse,
    ThreadArchiveParams,
    ThreadArchiveResponse,
    TurnCompletedNotification,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadSetNameParams,
    ThreadSetNameResponse,
    SkillsListParams,
    SkillsListResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse, ConfigReadParams, ConfigReadResponse,
} from "./app-server/v2";

export interface ApprovalHandler {
    handleCommandExecution(params: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse>;
    handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse>;
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

/**
 * Poorly supported/deprecated event types
 */
export type McpStartupCompleteNotification = { method: "codex/event/mcp_startup_complete", params: { id?: string, msg: McpStartupCompleteEvent & { type:"mcp_startup_complete" }, conversationId?: ConversationId } }

/**
 * A type-safe client over the Codex App Server's JSON-RPC API.
 * Maps each request to its expected response and exposes clear, typed methods for supported JSON-RPC operations.
 */
export class CodexAppServerClient {
    readonly connection: MessageConnection;
    private approvalHandlers = new Map<string, ApprovalHandler>();
    private pendingTurnCompletedEvents: Array<{
        key: string,
        event: TurnCompletedNotification,
    }> = [];
    private pendingTurnWaiters: Array<{
        key: string,
        predicate: (event: TurnCompletedNotification) => boolean,
        resolve: (event: TurnCompletedNotification) => void,
    }> = [];
    private expectedTurnCompletionCounts = new Map<string, number>();

    constructor(connection: MessageConnection) {
        this.connection = connection;
        this.connection.onUnhandledNotification((data) => {
            const serverNotification = data as ServerNotification ?? null;
            if (serverNotification) {
                this.notify(serverNotification);
            }
            for (const callback of this.codexEventHandlers) {
                callback({ eventType: "notification", ...serverNotification});
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

        this.connection.onNotification("turn/completed", (event: TurnCompletedNotification) => {
            const notification: ServerNotification = { method: "turn/completed", params: event };
            this.notify(notification);
            for (const callback of this.codexEventHandlers) {
                callback({ eventType: "notification", ...notification });
            }
            this.handleTurnCompleted(event);
        });
    }

    onApprovalRequest(threadId: string, handler: ApprovalHandler): void {
        this.approvalHandlers.set(threadId, handler);
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

    async threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {
        return await this.sendRequest({ method: "thread/fork", params: params });
    }

    async threadArchive(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
        return await this.sendRequest({ method: "thread/archive", params });
    }

    async threadSetName(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
        return await this.sendRequest({ method: "thread/name/set", params });
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

    async awaitLoginCompleted(): Promise<AccountLoginCompletedNotification> {
        return await new Promise((resolve) => {
            this.connection.onNotification("account/login/completed", (event: AccountLoginCompletedNotification) => {
                resolve(event);
            });
        });
    }

    async awaitAccountUpdated(): Promise<AccountUpdatedNotification> {
        return await new Promise((resolve) => {
            this.connection.onNotification("account/updated", (event: AccountUpdatedNotification) => {
                resolve(event);
            });
        });
    }

    async awaitMcpStartup(): Promise<McpStartupCompleteEvent> {
        return await new Promise((resolve) => {
            this.connection.onNotification("codex/event/mcp_startup_complete", (event: McpStartupCompleteNotification["params"]) => {
                resolve(event.msg);
            });
        });
    }

    async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return await this.sendRequest({ method: "account/read", params: params });
    }

    async awaitTurnCompletedForThread(threadId: string, turnId: string | null = null): Promise<TurnCompletedNotification> {
        const key = turnId === null
            ? this.makeThreadTurnCompletionKey(threadId)
            : this.makeTurnCompletionKey(threadId, turnId);

        return await this.awaitMatchingTurnCompleted(
            key,
            (event) => event.threadId === threadId && (turnId === null || event.turn.id === turnId)
        );
    }


    async setModelRequest(params: SetDefaultModelParams): Promise<SetDefaultModelResponse> {
        return await this.sendRequest({ method: "setDefaultModel", params });
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

    private handleTurnCompleted(event: TurnCompletedNotification): void {
        const waiterIndex = this.pendingTurnWaiters.findIndex(({predicate}) => predicate(event));
        if (waiterIndex >= 0) {
            const [waiter] = this.pendingTurnWaiters.splice(waiterIndex, 1);
            this.decrementExpectedTurnCompletion(waiter!.key);
            waiter!.resolve(event);
            return;
        }

        const turnId = event.turn?.id ?? null;
        const exactKey = turnId === null ? null : this.makeTurnCompletionKey(event.threadId, turnId);
        const threadKey = this.makeThreadTurnCompletionKey(event.threadId);
        const bufferKey =
            (exactKey !== null && this.hasExpectedTurnCompletion(exactKey))
                ? exactKey
                : (this.hasExpectedTurnCompletion(threadKey) ? threadKey : null);

        if (bufferKey !== null) {
            this.pendingTurnCompletedEvents.push({ key: bufferKey, event });
        }
    }

    private async awaitMatchingTurnCompleted(
        key: string,
        predicate: (event: TurnCompletedNotification) => boolean
    ): Promise<TurnCompletedNotification> {
        this.incrementExpectedTurnCompletion(key);

        const eventIndex = this.pendingTurnCompletedEvents.findIndex(({ key: eventKey, event }) =>
            eventKey === key && predicate(event)
        );
        if (eventIndex >= 0) {
            const [entry] = this.pendingTurnCompletedEvents.splice(eventIndex, 1);
            this.decrementExpectedTurnCompletion(key);
            return entry!.event;
        }

        return await new Promise((resolve) => {
            this.pendingTurnWaiters.push({key, predicate, resolve});
        });
    }

    private makeTurnCompletionKey(threadId: string, turnId: string): string {
        return `${threadId}:${turnId}`;
    }

    private makeThreadTurnCompletionKey(threadId: string): string {
        return `${threadId}:*`;
    }

    private hasExpectedTurnCompletion(key: string): boolean {
        return (this.expectedTurnCompletionCounts.get(key) ?? 0) > 0;
    }

    private incrementExpectedTurnCompletion(key: string): void {
        this.expectedTurnCompletionCounts.set(key, (this.expectedTurnCompletionCounts.get(key) ?? 0) + 1);
    }

    private decrementExpectedTurnCompletion(key: string): void {
        const next = (this.expectedTurnCompletionCounts.get(key) ?? 0) - 1;
        if (next > 0) {
            this.expectedTurnCompletionCounts.set(key, next);
        } else {
            this.expectedTurnCompletionCounts.delete(key);
        }
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

export type CodexConnectionEvent = { eventType: "request" } & CodexRequest | { eventType: "response" } & unknown | { eventType: "notification" } & ServerNotification;

type CodexRequest = DistributiveOmit<ClientRequest, "id">

type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;
