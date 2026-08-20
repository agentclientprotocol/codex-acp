import * as acp from "@agentclientprotocol/sdk";
import {
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./subagents/AcpSubagents";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export class ACPSessionConnection {
    private readonly connection: AcpClientConnection;
    readonly sessionId: string;

    constructor(connection: AcpClientConnection, sessionId: string) {
        this.connection = connection;
        this.sessionId = sessionId;
    }

    async update(update: UpdateSessionEvent, sessionId: string = this.sessionId) {
        await this.connection.notify(acp.methods.client.session.update, asSdkSessionNotification({
            sessionId,
            update: update
        }));
    }
}

export type UpdateSessionEvent = AcpSessionUpdate;
