import * as acp from "@agentclientprotocol/sdk";
import type {SessionNotification} from "@agentclientprotocol/sdk";

export class ACPSessionConnection {
    private readonly connection: acp.AgentSideConnection;
    readonly sessionId: string;

    constructor(connection: acp.AgentSideConnection, sessionId: string) {
        this.connection = connection;
        this.sessionId = sessionId;
    }

    async update(update: UpdateSessionEvent) {
        await this.connection.sessionUpdate({
            sessionId: this.sessionId,
            update: update
        });
    }
}

export type UpdateSessionEvent = SessionNotification["update"];