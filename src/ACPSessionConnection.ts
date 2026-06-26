import * as acp from "@agentclientprotocol/sdk";
import type {SessionNotification} from "@agentclientprotocol/sdk";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export class ACPSessionConnection {
    private readonly connection: AcpClientConnection;
    readonly sessionId: string;

    constructor(connection: AcpClientConnection, sessionId: string) {
        this.connection = connection;
        this.sessionId = sessionId;
    }

    async update(update: UpdateSessionEvent) {
        await this.connection.notify(acp.methods.client.session.update, {
            sessionId: this.sessionId,
            update: update
        });
    }
}

export type UpdateSessionEvent = SessionNotification["update"];
