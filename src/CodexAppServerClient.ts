import type {MessageConnection, NotificationMessage} from "vscode-jsonrpc/node";
import type {
    ClientRequest,
    EventMsg,
    InitializeParams,
    InitializeResponse,
    ServerNotification
} from "./app-server";
import type {
    AccountLoginCompletedNotification,
    GetAccountParams,
    GetAccountResponse, LoginAccountParams, LoginAccountResponse,
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

    async awaitLoginCompleted(): Promise<AccountLoginCompletedNotification> {
        return await new Promise((resolve) => {
            this.connection.onNotification("account/login/completed", (event: AccountLoginCompletedNotification) => {
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
        this.connection.onUnhandledNotification((data) => {
            const serverNotification = data as ServerNotification ?? null;
            if (serverNotification) {
                callback(serverNotification)
            }
        });
    }

    onUnhandledNotification(callback: (data: NotificationMessage) => void){
        this.connection.onUnhandledNotification((data) => {
            const event = this.getEventMessage(data);
            if (!event) {
                callback(data)
            }
        });
    }

    private getEventMessage(data: NotificationMessage): EventMsg | null {
        const params = data.params;
        return (params as { msg?: EventMsg })?.msg ?? null;
    }

    private async sendRequest<R>(request: CodexRequest): Promise<R> {
        return await this.connection.sendRequest(request.method, request.params);
    }
}

type CodexRequest = DistributiveOmit<ClientRequest, "id">

type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;