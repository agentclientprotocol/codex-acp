import type {MessageConnection, NotificationMessage} from "vscode-jsonrpc/node";
import type {
    ClientRequest,
    EventMsg,
    InitializeParams,
    InitializeResponse,
    ServerNotification
} from "./app-server";
import type {
    AccountLoginCompletedNotification, AccountUpdatedNotification,
    GetAccountParams,
    GetAccountResponse, LoginAccountParams, LoginAccountResponse, LogoutAccountResponse,
    ThreadStartParams,
    ThreadStartResponse,
    TurnCompletedNotification,
    TurnStartParams,
    TurnStartResponse
} from "./app-server/v2";

/**
 * A type-safe client over the Codex App Server's JSON-RPC API.
 * Maps each request to its expected response and exposes clear, typed methods for supported JSON-RPC operations.
 */
export class CodexAppServerClient {
    readonly connection: MessageConnection;

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
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        return await this.sendRequest({ method: "initialize", params: params });
    }

    async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
        return await this.sendRequest({ method: "turn/start", params: params });
    }

    async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
        return await this.sendRequest({ method: "thread/start", params: params });
    }

    async accountLogin(params: LoginAccountParams): Promise<LoginAccountResponse> {
        return await this.sendRequest({ method: "account/login/start", params: params });
    }

    async accountLogout(): Promise<LogoutAccountResponse> {
        return await this.sendRequest({ method: "account/logout", params: undefined });
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

    async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return await this.sendRequest({ method: "account/read", params: params });
    }

    async awaitTurnCompleted(): Promise<TurnCompletedNotification> {
        return await new Promise((resolve) => {
            this.connection.onNotification("turn/completed", (event: TurnCompletedNotification) => {
                resolve(event);
            });
        });
    }

    onServerNotification(callback: (event: ServerNotification) => void){
        this.notificationHandlers.push(callback);
    }

    private codexEventHandlers: Array<(event: CodexConnectionEvent) => void> = [];
    onClientTransportEvent(callback: (event: CodexConnectionEvent) => void){
        this.codexEventHandlers.push(callback);
    }

    private notificationHandlers: Array<(event: ServerNotification) => void> = [];
    private notify(notification: ServerNotification) {
        for (const notificationHandler of this.notificationHandlers) {
            notificationHandler(notification);
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
            await this.connection.sendRequest<R>(request.method);
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