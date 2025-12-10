import type {MessageConnection, NotificationMessage} from "vscode-jsonrpc/node";
import type {
    ClientRequest,
    EventMsg,
    InitializeParams,
    InitializeResponse,
    LoginChatGptResponse,
    ServerNotification
} from "./app-server";
import type {
    AccountLoginCompletedNotification,
    GetAccountParams,
    GetAccountResponse,
    ThreadStartParams,
    ThreadStartResponse,
    TurnCompletedNotification,
    TurnStartParams,
    TurnStartResponse
} from "./app-server/v2";
import open from "open";

export class CodexClient {
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

    async loginWithApiKey(apiKey: string): Promise<Boolean> {
        await this.sendRequest({
            method: "account/login/start",
            params: { type: "apiKey", apiKey: apiKey }
        });
        const result = await this.awaitLogin();
        return result.success
    }

    async loginWithChatGpt(): Promise<Boolean> {
        const response: LoginChatGptResponse = await this.sendRequest({
            method: "account/login/start",
            params: { type: "chatgpt" }
        });
        await open(response.authUrl);
        const result = await this.awaitLogin();
        return result.success

}
    private async awaitLogin(): Promise<AccountLoginCompletedNotification> {
        return await new Promise((resolve) => {
            this.connection.onNotification("account/login/completed", (event: AccountLoginCompletedNotification) => {
                resolve(event);
            });
        });
    }

    private async accountRead(params: GetAccountParams): Promise<GetAccountResponse> {
        return await this.sendRequest({ method: "account/read", params: params });
    }

    async loginStatus(): Promise<Boolean> {
        const response = await this.accountRead({refreshToken: false})
        return !response.requiresOpenaiAuth || response.account !== null;
    }

    async waitForCompletion(): Promise<TurnCompletedNotification> {
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

    async close(){
        this.connection.end();
    }

    private async sendRequest<R>(request: CodexRequest): Promise<R> {
        return await this.connection.sendRequest(request.method, request.params);
    }
}

type CodexRequest = Omit<ClientRequest, "id">;