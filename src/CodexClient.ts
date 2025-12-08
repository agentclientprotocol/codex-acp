import type {MessageConnection, NotificationMessage} from "vscode-jsonrpc/node";
import type {
    AddConversationListenerParams, AddConversationSubscriptionResponse,
    ClientRequest, EventMsg,
    InitializeParams,
    InitializeResponse,
    NewConversationParams,
    NewConversationResponse, SendUserMessageParams, SendUserMessageResponse, TaskCompleteEvent
} from "./app-server";

export class CodexClient {
    readonly connection: MessageConnection;

    constructor(connection: MessageConnection) {
        this.connection = connection;
    }

    async initialize(params: InitializeParams) {
        const response: InitializeResponse = await this.connection.sendRequest("initialize", params)
        return response;
    }

    async newConversation(params: NewConversationParams){
        const response: NewConversationResponse = await this.connection.sendRequest("newConversation", params)
        return response;
    }

    async sendUserMessage(params: SendUserMessageParams) {
        const response: SendUserMessageResponse = await this.connection.sendRequest("sendUserMessage", params)
        return response;
    }

    async addConversationListener(params: AddConversationListenerParams){
        const response: AddConversationSubscriptionResponse = await this.connection.sendRequest("addConversationListener", params)
        return response;
    }

    async waitForCompletion(){
        await new Promise((resolve) => {
            this.connection.onNotification("codex/event/task_complete", (event: TaskCompleteEvent) => {
                resolve(event);
            });
        });
    }

    onMessageEvent(callback: (event: EventMsg) => void){
        this.connection.onUnhandledNotification((data) => {
            const event = this.getEventMessage(data);
            if (event) {
                callback(event)
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

}