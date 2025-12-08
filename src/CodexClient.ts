import type {MessageConnection, NotificationMessage} from "vscode-jsonrpc/node";
import type {
    AddConversationListenerParams, AddConversationSubscriptionResponse,
    ClientRequest, EventMsg,
    InitializeParams,
    InitializeResponse,
    NewConversationParams,
    NewConversationResponse, SendUserMessageParams, SendUserMessageResponse, ServerNotification, TaskCompleteEvent
} from "./app-server";
import type {
    ThreadStartParams,
    ThreadStartResponse,
    TurnCompletedNotification,
    TurnStartParams,
    TurnStartResponse
} from "./app-server/v2";

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