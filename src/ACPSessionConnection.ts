import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./AcpSessionExtensions";
import {toV2SessionUpdate} from "./AcpV2SessionUpdate";

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

    /** Sends a session update, rendered in the v2 wire shape, through the v2 `session/update` binding. */
    async updateSession(sessionId: string, update: AcpSessionUpdate): Promise<void> {
        await this.client.notify(acpV2.methods.client.session.update, {
            sessionId,
            update: toV2SessionUpdate(update),
        });
    }

    /** Sends a `state_update`, which only exists on v2 and so needs no rendering. */
    async updateState(sessionId: string, state: acpV2.StateUpdate): Promise<void> {
        await this.client.notify(acpV2.methods.client.session.update, {
            sessionId,
            update: {sessionUpdate: "state_update", ...state},
        });
    }

    /**
     * A v1-typed view for code that has no v2 send path yet. `_`-prefixed extension methods
     * are forwarded as-is: their payloads are the same on both versions. `session/update` is
     * rendered in the v2 shape. Other standard methods are rejected rather than sent in the
     * v1 wire shape.
     */
    extensionOnlyV1View(): AcpClientConnection {
        const view = {
            notify: (method: string, params?: unknown) => {
                if (method.startsWith("_")) {
                    return this.client.notify(method as `_${string}`, params);
                }
                if (method === acp.methods.client.session.update) {
                    const notification = params as acp.SessionNotification;
                    return this.updateSession(notification.sessionId, notification.update);
                }
                return rejectStandardMethod(method);
            },
            request: (method: string, params?: unknown, options?: acp.SendRequestOptions) => method.startsWith("_")
                ? this.client.request(method as `_${string}`, params, options)
                : rejectStandardMethod(method),
        } as AcpClientConnection;
        v2ConnectionsByView.set(view, this);
        return view;
    }

    /** The v2 connection behind a view made by `extensionOnlyV1View()`, or `null` for a v1 connection. */
    static of(connection: AcpClientConnection): AcpV2Connection | null {
        return v2ConnectionsByView.get(connection) ?? null;
    }
}

const v2ConnectionsByView = new WeakMap<AcpClientConnection, AcpV2Connection>();

function rejectStandardMethod(method: string): Promise<never> {
    return Promise.reject(
        acp.RequestError.internalError(undefined, `'${method}' is not supported on an ACP v2 connection yet`),
    );
}

/**
 * The single send point for `session/update`. Callers build v1-shaped updates; on a v2
 * connection they are rendered in the v2 wire shape by `toV2SessionUpdate`.
 */
export class ACPSessionConnection {
    private readonly connection: AcpClientConnection;
    private readonly v2Connection: AcpV2Connection | null;
    readonly sessionId: string;

    constructor(connection: AcpClientConnection, sessionId: string) {
        this.connection = connection;
        this.v2Connection = AcpV2Connection.of(connection);
        this.sessionId = sessionId;
    }

    get protocolVersion(): 1 | 2 {
        return this.v2Connection ? 2 : 1;
    }

    /** Reports the session's foreground-work state. v1 has no such update, so this is v2 only. */
    async updateState(state: acpV2.StateUpdate): Promise<void> {
        if (!this.v2Connection) {
            throw acp.RequestError.internalError(undefined, "'state_update' does not exist in ACP v1");
        }
        await this.v2Connection.updateState(this.sessionId, state);
    }

    async update(update: UpdateSessionEvent, sessionId: string = this.sessionId) {
        if (this.v2Connection) {
            await this.v2Connection.updateSession(sessionId, update);
            return;
        }
        await this.connection.notify(acp.methods.client.session.update, asSdkSessionNotification({
            sessionId,
            update: update
        }));
    }
}

export type UpdateSessionEvent = AcpSessionUpdate;
