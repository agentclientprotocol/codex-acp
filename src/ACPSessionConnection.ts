import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    type AcpSessionNotification,
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./AcpSessionExtensions";
import {toV2SessionUpdates} from "./AcpV2SessionUpdate";
import {toV2ReplayUpdates} from "./AcpV2Replay";
import {toV1RequestPermissionResponse, toV2RequestPermissionRequest} from "./AcpV2Permissions";
import {elicitationSessionId, toV1CreateElicitationResponse, toV2CreateElicitationRequest} from "./AcpV2Elicitation";
import {AcpV2ForegroundState} from "./AcpV2ForegroundState";
import {AcpV2SessionInfo, type SessionInfoFields, type SessionMetadataPatch} from "./AcpV2SessionInfo";
import {type AcpClientDelivery, clientNotificationSessionId, clientRequestSessionId} from "./AcpClientDelivery";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export type AcpV2ClientConnection = Pick<acpV2.AgentContext, "notify" | "request">;

/**
 * The client handle of a connection the protocol router routed to the ACP v2 chain.
 */
export class AcpV2Connection {
    readonly client: AcpV2ClientConnection;
    private isTurnRunning: (sessionId: string) => boolean = () => true;
    private readonly foreground = new Map<string, AcpV2ForegroundState>();
    private readonly sessionInfo = new Map<string, AcpV2SessionInfo>();
    private sessionDelivery: AcpClientDelivery | null = null;
    private sendElicitationCompletion: (params: unknown) => Promise<void>;

    constructor(private readonly transportClient: AcpV2ClientConnection) {
        const client = transportClient;
        this.sendElicitationCompletion = params => client.notify(acpV2.methods.client.elicitation.complete, params as acpV2.CompleteElicitationNotification);
        this.client = {
            notify: (method: string, params?: unknown) => {
                if (method === acpV2.methods.client.elicitation.complete) return this.sendElicitationCompletion(params);
                const sessionId = clientNotificationSessionId(method, params);
                if (sessionId !== null && this.sessionDelivery && !this.sessionDelivery.canPublishSession(sessionId)) return Promise.resolve();
                if (sessionId !== null) {
                    const {update, _meta} = params as acpV2.UpdateSessionNotification;
                    if (acpV2.SessionUpdate.isSessionInfoUpdate(update)) return this.sessionInfoFor(sessionId).update(update, _meta);
                }
                return client.notify(method as `_${string}`, params);
            },
            request: (method: string, params?: unknown, options?: acpV2.SendRequestOptions) => {
                const sessionId = clientRequestSessionId(method, params);
                if (sessionId !== null && this.sessionDelivery && !this.sessionDelivery.canRequestSession(sessionId)) {
                    return Promise.reject(acp.RequestError.requestCancelled(undefined, `Session ${sessionId} is closing or closed`));
                }
                const send = () => {
                    const request = () => client.request(method as `_${string}`, params, options);
                    return this.sessionDelivery?.withElicitationRequest(method, params, request) ?? request();
                };
                const setup = sessionId === null ? null : this.sessionDelivery?.waitForSessionSetup(sessionId, options?.cancellationSignal);
                return setup ? setup.then(send) : send();
            },
        } as AcpV2ClientConnection;
    }

    setClientDelivery(delivery: AcpClientDelivery): void {
        this.sessionDelivery = delivery;
        delivery.setElicitationCompletionTransport(params => this.transportClient.notify(
            acpV2.methods.client.elicitation.complete, params as acpV2.CompleteElicitationNotification,
        ));
        this.sendElicitationCompletion = params => delivery.notify(acp.methods.client.elicitation.complete, params);
    }

    /** Identifies foreground interactions; background requests do not affect session state. */
    setTurnRunningCheck(check: (sessionId: string) => boolean): void {
        this.isTurnRunning = check;
    }

    private async withUserAction<T>(
        sessionId: string,
        itemId: string | undefined,
        sendRequest: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!this.isTurnRunning(sessionId)) {
            return sendRequest();
        }
        return this.foregroundFor(sessionId).withUserAction(itemId, sendRequest, signal);
    }

    /**
     * Sends a session update, rendered in the v2 wire shape, through the v2 `session/update`
     * binding. One update can render to several v2 updates (or none), sent in order.
     */
    async updateSession(sessionId: string, update: AcpSessionUpdate, metadata?: acpV2.UpdateSessionNotification["_meta"]): Promise<void> {
        for (const v2Update of toV2SessionUpdates(update)) {
            await this.client.notify(acpV2.methods.client.session.update,
                {sessionId, update: v2Update, ...(metadata !== undefined ? {_meta: metadata} : {})});
        }
    }

    /** Sends a `state_update`, which only exists on v2 and so needs no rendering. */
    async updateState(sessionId: string, state: acpV2.StateUpdate): Promise<void> {
        await this.foregroundFor(sessionId).update(state);
    }

    startForegroundWork(sessionId: string): Promise<void> {
        return this.foregroundFor(sessionId).start();
    }

    snapshotForegroundState(sessionId: string): Promise<void> {
        return this.foregroundFor(sessionId).snapshot();
    }

    resetSessionInfo(sessionId: string, metadata: Record<string, unknown> | null): void {
        this.sessionInfo.get(sessionId)?.dispose();
        this.sessionInfo.delete(sessionId);
        this.sessionInfoFor(sessionId, metadata);
    }

    refreshSessionInfo(sessionId: string, metadata: Record<string, unknown> | null): Promise<void> {
        return metadata ? this.sessionInfoFor(sessionId).seedMetadata(metadata) : Promise.resolve();
    }

    snapshotSessionInfo(sessionId: string, title: string | null): Promise<void> {
        return this.sessionInfoFor(sessionId).snapshot(title);
    }

    patchSessionMetadata(sessionId: string, change: SessionMetadataPatch, fields: SessionInfoFields = {}): Promise<void> {
        return this.sessionInfoFor(sessionId).patchMetadata(change, fields);
    }

    startForegroundItem(sessionId: string, itemId: string): Promise<void> {
        return this.foregroundFor(sessionId).startItem(itemId);
    }

    completeForegroundItem(sessionId: string, itemId: string): Promise<void> {
        return this.foregroundFor(sessionId).completeItem(itemId);
    }

    restoreForegroundState(sessionId: string, running: boolean): void {
        this.foregroundFor(sessionId, running);
    }

    forgetSession(sessionId: string): void {
        this.forgetForegroundState(sessionId);
        this.sessionInfo.get(sessionId)?.dispose();
        this.sessionInfo.delete(sessionId);
    }

    forgetForegroundState(sessionId: string): void {
        this.foreground.get(sessionId)?.dispose();
        this.foreground.delete(sessionId);
    }

    private sessionInfoFor(sessionId: string, metadata: Record<string, unknown> | null = null): AcpV2SessionInfo {
        if (this.sessionDelivery && !this.sessionDelivery.canPublishSession(sessionId)) {
            const closed = new AcpV2SessionInfo(async () => {});
            closed.dispose();
            return closed;
        }
        let info = this.sessionInfo.get(sessionId);
        if (!info) {
            info = new AcpV2SessionInfo((update, notificationMetadata) => {
                if (this.sessionDelivery && !this.sessionDelivery.canPublishSession(sessionId)) return Promise.resolve();
                return this.transportClient.notify(acpV2.methods.client.session.update,
                    {sessionId, update, ...(notificationMetadata !== undefined ? {_meta: notificationMetadata} : {})});
            }, metadata);
            this.sessionInfo.set(sessionId, info);
        }
        return info;
    }

    private foregroundFor(sessionId: string, running = false): AcpV2ForegroundState {
        if (this.sessionDelivery && !this.sessionDelivery.canPublishSession(sessionId)) {
            const closed = new AcpV2ForegroundState(async () => {});
            closed.dispose();
            return closed;
        }
        let foreground = this.foreground.get(sessionId);
        if (!foreground) {
            foreground = new AcpV2ForegroundState(
                state => this.client.notify(acpV2.methods.client.session.update, {
                    sessionId,
                    update: {sessionUpdate: "state_update", ...state},
                }),
                running,
            );
            this.foreground.set(sessionId, foreground);
        }
        return foreground;
    }

    async replaySessionUpdate(sessionId: string, update: AcpSessionUpdate, initialized: Set<string>): Promise<void> {
        const send = async (params: {sessionId: string; update: AcpSessionUpdate}) => {
            for (const rendered of toV2SessionUpdates(params.update)) {
                for (const replayed of toV2ReplayUpdates(rendered, initialized)) {
                    await this.client.notify(acpV2.methods.client.session.update, {sessionId: params.sessionId, update: replayed});
                }
            }
        };
        const params = {sessionId, update};
        if (this.sessionDelivery) await this.sessionDelivery.withSessionUpdate(params, send);
        else await send(params);
    }

    /** Sends permission requests without mistaking one pending request for a blocked session. */
    async requestPermission(
        request: acp.RequestPermissionRequest,
        options?: acp.SendRequestOptions,
    ): Promise<acp.RequestPermissionResponse> {
        return this.withUserAction(request.sessionId, request.toolCall.toolCallId, async () => {
            const response = await this.client.request(
                acpV2.methods.client.session.requestPermission,
                toV2RequestPermissionRequest(request),
                options,
            );
            return toV1RequestPermissionResponse(response);
        }, options?.cancellationSignal);
    }

    /**
     * Sends `elicitation/create`. Request-scoped login elicitations and idle background elicitations never change
     * the session state.
     *
     * @param request The elicitation to show.
     * @param options Request options, such as the signal that cancels the request.
     * @param interaction.userAction Whether the agent waits for the answer, `true` by default. While such an
     *     elicitation is open in a running turn, the session reports `requires_action` whenever none of its items
     *     is in progress. Pass `false` for a question the agent keeps working through, so the session state is left
     *     as it is.
     */
    async createElicitation(
        request: acp.CreateElicitationRequest,
        options?: acp.SendRequestOptions,
        interaction: {userAction?: boolean} = {},
    ): Promise<acp.CreateElicitationResponse> {
        const userAction = interaction.userAction ?? true;
        const sendRequest = async () => {
            const response = await this.client.request(
                acpV2.methods.client.elicitation.create,
                toV2CreateElicitationRequest(request),
                options,
            );
            return toV1CreateElicitationResponse(response);
        };
        const sessionId = elicitationSessionId(request);
        if (sessionId === undefined || !userAction) {
            return sendRequest();
        }
        const toolCallId = "toolCallId" in request && typeof request.toolCallId === "string" ? request.toolCallId : undefined;
        return this.withUserAction(sessionId, toolCallId, sendRequest, options?.cancellationSignal);
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
                    const notification = params as AcpSessionNotification;
                    return this.updateSession(notification.sessionId, notification.update, notification._meta);
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

    /** Lets `of()` find this connection behind a view that wraps one made by `extensionOnlyV1View()`. */
    registerView(view: AcpClientConnection): void {
        v2ConnectionsByView.set(view, this);
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

    async updateSubagentState(childSessionId: string, parentSessionId: string, state: acpV2.StateUpdate): Promise<void> {
        if (this.v2Connection) {
            await this.v2Connection.client.notify(acpV2.methods.client.session.update, {
                sessionId: childSessionId, update: {sessionUpdate: "state_update", ...state},
            });
        }
        await this.update({sessionUpdate: "subagent_update", sessionId: childSessionId, state}, parentSessionId);
    }

    forSession(sessionId: string): ACPSessionConnection { return new ACPSessionConnection(this.connection, sessionId); }

    /** Domain writers can rebuild an owned metadata value without changing v2's shallow patch semantics. */
    patchSessionMetadata(change: SessionMetadataPatch, fields: SessionInfoFields = {}): Promise<void> {
        return this.v2Connection?.patchSessionMetadata(this.sessionId, change, fields) ?? Promise.resolve();
    }

    /** Replay shares live report filtering, with v2 entity initialization after conversion. */
    replayUpdate(update: UpdateSessionEvent, initialized: Set<string>): Promise<void> {
        return this.v2Connection
            ? this.v2Connection.replaySessionUpdate(this.sessionId, update, initialized)
            : this.update(update);
    }

    /** On v2, the view renders the update in the v2 shape (`extensionOnlyV1View`). */
    async update(update: UpdateSessionEvent, sessionId: string = this.sessionId) {
        await this.connection.notify(acp.methods.client.session.update, asSdkSessionNotification({
            sessionId,
            update: update
        }));
    }
}

export type UpdateSessionEvent = AcpSessionUpdate;
