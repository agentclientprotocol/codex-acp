import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./AcpSessionExtensions";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export type AcpV2ClientConnection = Pick<acpV2.AgentContext, "notify" | "request">;

/**
 * The client handle of a connection the protocol router routed to the ACP v2 chain.
 */
export class AcpV2Connection {
    readonly client: AcpV2ClientConnection;

    constructor(client: AcpV2ClientConnection) {
        this.client = client;
    }

    /**
     * A v1-typed view for code that has no v2 send path yet. Only `_`-prefixed extension
     * methods are forwarded: their payloads are the same on both versions. Standard methods
     * are rejected rather than sent in the v1 wire shape.
     */
    extensionOnlyV1View(): AcpClientConnection {
        const client = this.client;
        const rejectStandardMethod = (method: string) => Promise.reject(
            acp.RequestError.internalError(undefined, `'${method}' is not supported on an ACP v2 connection yet`),
        );
        return {
            notify: (method: string, params?: unknown) => method.startsWith("_")
                ? client.notify(method as `_${string}`, params)
                : rejectStandardMethod(method),
            request: (method: string, params?: unknown, options?: acp.SendRequestOptions) => method.startsWith("_")
                ? client.request(method as `_${string}`, params, options)
                : rejectStandardMethod(method),
        } as AcpClientConnection;
    }
}

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
