import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    type AcpSessionNotification,
    type AcpSessionUpdate,
    asSdkSessionNotification,
} from "./AcpSessionExtensions";
import {toV2SessionUpdates} from "./AcpV2SessionUpdate";
import {toV1RequestPermissionResponse, toV2RequestPermissionRequest} from "./AcpV2Permissions";
import {elicitationSessionId, toV1CreateElicitationResponse, toV2CreateElicitationRequest} from "./AcpV2Elicitation";
import {AcpV2ForegroundState} from "./AcpV2ForegroundState";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export type AcpV2ClientConnection = Pick<acpV2.AgentContext, "notify" | "request">;

/**
 * The client handle of a connection the protocol router routed to the ACP v2 chain.
 */
export class AcpV2Connection {
    readonly client: AcpV2ClientConnection;
    private isTurnRunning: (sessionId: string) => boolean = () => true;
    private readonly foreground = new Map<string, AcpV2ForegroundState>();

    constructor(client: AcpV2ClientConnection) {
        this.client = client;
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
    async updateSession(sessionId: string, update: AcpSessionUpdate): Promise<void> {
        for (const v2Update of toV2SessionUpdates(update)) {
            await this.client.notify(acpV2.methods.client.session.update, {sessionId, update: v2Update});
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
        this.foreground.get(sessionId)?.dispose();
        this.foreground.delete(sessionId);
    }

    private foregroundFor(sessionId: string, running = false): AcpV2ForegroundState {
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

    /**
     * Sends the whole-message update (`content: []`) that must precede the first replayed chunk
     * for a given id, clearing any content a reconnecting client already holds for it. Only
     * `user_message`, `agent_message` and `agent_thought` exist as whole-message updates; there
     * is no v1 shape for them, so this bypasses `toV2SessionUpdates` entirely.
     */
    async startReplayMessage(sessionId: string, kind: ReplayMessageKind, messageId: string): Promise<void> {
        let update: acpV2.SessionUpdate;
        switch (kind) {
            case "user_message":
                update = {sessionUpdate: "user_message", messageId, content: []};
                break;
            case "agent_message":
                update = {sessionUpdate: "agent_message", messageId, content: []};
                break;
            case "agent_thought":
                update = {sessionUpdate: "agent_thought", messageId, content: []};
                break;
        }
        await this.client.notify(acpV2.methods.client.session.update, {
            sessionId,
            update,
        });
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

    /** Request-scoped login elicitations and idle background elicitations never change state. */
    async createElicitation(
        request: acp.CreateElicitationRequest,
        options?: acp.SendRequestOptions,
    ): Promise<acp.CreateElicitationResponse> {
        const sendRequest = async () => {
            const response = await this.client.request(
                acpV2.methods.client.elicitation.create,
                toV2CreateElicitationRequest(request),
                options,
            );
            return toV1CreateElicitationResponse(response);
        };
        const sessionId = elicitationSessionId(request);
        if (sessionId === undefined) {
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

    /** Standard children carry one state snapshot on their own v2 stream and their parent's roster. */
    async updateSubagentState(childSessionId: string, parentSessionId: string, state: acpV2.StateUpdate): Promise<void> {
        if (this.v2Connection) {
            await this.v2Connection.client.notify(acpV2.methods.client.session.update, {
                sessionId: childSessionId, update: {sessionUpdate: "state_update", ...state},
            });
        }
        await this.update({sessionUpdate: "subagent_update", sessionId: childSessionId, state}, parentSessionId);
    }

    forSession(sessionId: string): ACPSessionConnection {
        return new ACPSessionConnection(this.connection, sessionId);
    }
    /** `startReplayMessage`, which only exists on v2 and so needs no v1 shape. */
    async startReplayMessage(kind: ReplayMessageKind, messageId: string): Promise<void> {
        if (!this.v2Connection) {
            throw acp.RequestError.internalError(undefined, `'${kind}' does not exist in ACP v1`);
        }
        await this.v2Connection.startReplayMessage(this.sessionId, kind, messageId);
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

/** The v2 whole-message update kinds that a replayed chunk stream can restart. */
export type ReplayMessageKind = "user_message" | "agent_message" | "agent_thought";
