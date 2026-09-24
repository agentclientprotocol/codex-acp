import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./AcpSessionExtensions";
import {toV2SessionUpdates} from "./AcpV2SessionUpdate";
import {toV1RequestPermissionResponse, toV2RequestPermissionRequest} from "./AcpV2Permissions";
import {elicitationSessionId, toV1CreateElicitationResponse, toV2CreateElicitationRequest} from "./AcpV2Elicitation";
import {logger} from "./Logger";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export type AcpV2ClientConnection = Pick<acpV2.AgentContext, "notify" | "request">;

/**
 * The client handle of a connection the protocol router routed to the ACP v2 chain.
 */
export class AcpV2Connection {
    readonly client: AcpV2ClientConnection;
    private isTurnRunning: (sessionId: string) => boolean = () => true;

    constructor(client: AcpV2ClientConnection) {
        this.client = client;
    }

    /**
     * Lets the owning server report whether a turn is still running for a session, so
     * `requestPermission()`'s trailing `running` (below) is only sent when one genuinely is:
     * a permission request that outlives its turn must not undo the `idle` already sent for it.
     * Defaults to always running, so callers that never wire this up keep the old behavior.
     */
    setTurnRunningCheck(check: (sessionId: string) => boolean): void {
        this.isTurnRunning = check;
    }

    /**
     * Sends a session update, rendered in the v2 wire shape, through the v2 `session/update`
     * binding. One update can render to several v2 updates (or none), sent in order.
     */
    async updateSession(sessionId: string, update: AcpSessionUpdate): Promise<void> {
        for (const v2Update of toV2SessionUpdates(update)) {
            await this.client.notify(acpV2.methods.client.session.update, {sessionId, update: v2Update});
        }
    }

    /** Sends a `state_update`, which only exists on v2 and so needs no rendering. */
    async updateState(sessionId: string, state: acpV2.StateUpdate): Promise<void> {
        await this.client.notify(acpV2.methods.client.session.update, {
            sessionId,
            update: {sessionUpdate: "state_update", ...state},
        });
    }

    /** `updateState`, with send failures caught and logged instead of propagated. */
    private async sendState(sessionId: string, state: acpV2.StateUpdate): Promise<void> {
        try {
            await this.updateState(sessionId, state);
        } catch (error) {
            logger.error(`Failed to send the '${state.state}' state for session ${sessionId}`, error);
        }
    }

    /**
     * Sends `session/request_permission`, rendered in the v2 wire shape by
     * `toV2RequestPermissionRequest`. Per the spec, brackets the request with `requires_action`/
     * `running` `state_update`s: `requires_action` while the request is pending, `running` again
     * once it settles (granted, denied, cancelled, or errored all count as resumed) -- but only
     * if a turn is still running by then; otherwise the turn already went `idle` on its own and
     * this must not resurrect `running` after it.
     */
    async requestPermission(
        request: acp.RequestPermissionRequest,
        options?: acp.SendRequestOptions,
    ): Promise<acp.RequestPermissionResponse> {
        await this.sendState(request.sessionId, {state: "requires_action"});
        try {
            const response = await this.client.request(
                acpV2.methods.client.session.requestPermission,
                toV2RequestPermissionRequest(request),
                options,
            );
            return toV1RequestPermissionResponse(response);
        } finally {
            if (this.isTurnRunning(request.sessionId)) {
                await this.sendState(request.sessionId, {state: "running"});
            }
        }
    }

    /**
     * Sends `elicitation/create` (wire-identical request/response between versions, per
     * `AcpV2Elicitation`). Brackets it with `requires_action`/`running` `state_update`s like
     * `requestPermission()`, but only when the elicitation is session-scoped: a request-scoped
     * elicitation (e.g. device-code login, sent before any session exists) has no session to
     * attach a state update to.
     */
    async createElicitation(
        request: acp.CreateElicitationRequest,
        options?: acp.SendRequestOptions,
    ): Promise<acp.CreateElicitationResponse> {
        const sessionId = elicitationSessionId(request);
        if (sessionId === undefined) {
            const response = await this.client.request(
                acpV2.methods.client.elicitation.create,
                toV2CreateElicitationRequest(request),
                options,
            );
            return toV1CreateElicitationResponse(response);
        }
        await this.sendState(sessionId, {state: "requires_action"});
        try {
            const response = await this.client.request(
                acpV2.methods.client.elicitation.create,
                toV2CreateElicitationRequest(request),
                options,
            );
            return toV1CreateElicitationResponse(response);
        } finally {
            if (this.isTurnRunning(sessionId)) {
                await this.sendState(sessionId, {state: "running"});
            }
        }
    }

    /** Sends `elicitation/complete`, wire-identical between versions. */
    async completeElicitation(notification: acp.CompleteElicitationNotification): Promise<void> {
        await this.client.notify(acpV2.methods.client.elicitation.complete, notification);
    }

    /**
     * A v1-typed view for code that has no v2 send path yet. `_`-prefixed extension methods
     * are forwarded as-is: their payloads are the same on both versions. `session/update`,
     * `session/request_permission` and the elicitation methods are rendered in the v2 shape.
     * Other standard methods are rejected rather than sent in the v1 wire shape.
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
                if (method === acp.methods.client.elicitation.complete) {
                    return this.completeElicitation(params as acp.CompleteElicitationNotification);
                }
                return rejectStandardMethod(method);
            },
            request: (method: string, params?: unknown, options?: acp.SendRequestOptions) => {
                if (method.startsWith("_")) {
                    return this.client.request(method as `_${string}`, params, options);
                }
                if (method === acp.methods.client.session.requestPermission) {
                    return this.requestPermission(params as acp.RequestPermissionRequest, options);
                }
                if (method === acp.methods.client.elicitation.create) {
                    return this.createElicitation(params as acp.CreateElicitationRequest, options);
                }
                return rejectStandardMethod(method);
            },
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
 * connection they are rendered in the v2 wire shape by `toV2SessionUpdates`.
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
