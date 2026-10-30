import * as acp from "@agentclientprotocol/sdk/unstable";
import type {AcpClientConnection, UpdateSessionEvent} from "./ACPSessionConnection";
import {ToolCallReports} from "./ToolCallReports";

type SessionUpdateParams = {sessionId: string; update: UpdateSessionEvent};

/**
 * Sends the notifications and requests of the adapter to the ACP client.
 *
 * Shared policy for tool-report filtering, session publication and interaction cancellation,
 * whether the work belongs to a prompt, background activity or session startup.
 */
export class AcpClientDelivery {
    readonly reports = new ToolCallReports();
    private readonly sessionRequests = new Map<string, Set<AbortController>>();
    private readonly closedSessions = new Set<string>();
    private readonly urlElicitations = new Map<string, {sessionId: string | null}>();
    private readonly sessionSetups = new Map<string, {ready: Promise<void>; release: () => void}>();
    private sendElicitationCompletion: (params: unknown) => Promise<void>;

    constructor(
        private readonly client: AcpClientConnection,
        private readonly sessionIsClosing: (sessionId: string) => boolean = () => false,
    ) {
        this.sendElicitationCompletion = params => client.notify(acp.methods.client.elicitation.complete, params as acp.CompleteElicitationNotification);
    }

    /** v2's direct send path shares URL scope tracking without routing back through its v1 view. */
    setElicitationCompletionTransport(send: (params: unknown) => Promise<void>): void {
        this.sendElicitationCompletion = send;
    }

    /** Returns this connection with the signature of the SDK connection. */
    asClientConnection(): AcpClientConnection {
        return this as unknown as AcpClientConnection;
    }

    openSession(sessionId: string): void {
        this.closedSessions.delete(sessionId);
    }

    /** A new session cannot open client UI until its setup response has been written. */
    beginSessionSetup(sessionId: string): void {
        if (this.sessionSetups.has(sessionId)) return;
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        this.sessionSetups.set(sessionId, {ready, release});
    }

    sessionSetupReady(sessionId: string): Promise<void> | null {
        return this.sessionSetups.get(sessionId)?.ready ?? null;
    }

    captureSessionSetupRelease(sessionId: string): () => void {
        const setup = this.sessionSetups.get(sessionId);
        return () => {
            if (setup && this.sessionSetups.get(sessionId) === setup) this.finishSessionSetup(sessionId);
        };
    }

    private finishSessionSetup(sessionId: string): void {
        const setup = this.sessionSetups.get(sessionId);
        this.sessionSetups.delete(sessionId);
        setup?.release();
    }

    waitForSessionSetup(sessionId: string, signal?: AbortSignal): Promise<void> | null {
        const ready = this.sessionSetupReady(sessionId);
        if (!ready) return null;
        return new Promise<void>((resolve, reject) => {
            const cancelled = () => reject(acp.RequestError.requestCancelled(undefined, `Session ${sessionId} setup was cancelled`));
            if (signal?.aborted) { cancelled(); return; }
            signal?.addEventListener("abort", cancelled, {once: true});
            void ready.then(() => {
                signal?.removeEventListener("abort", cancelled);
                if (signal?.aborted || !this.canRequestSession(sessionId)) cancelled();
                else resolve();
            });
        });
    }

    disposeSessionSetups(): void {
        for (const sessionId of this.sessionSetups.keys()) {
            this.closedSessions.add(sessionId);
            this.cancelSessionRequests(sessionId);
        }
    }

    /** Final teardown updates have been sent. Nothing else may publish for this session lifetime. */
    closeSession(sessionId: string): void {
        this.closedSessions.add(sessionId);
        this.finishSessionSetup(sessionId);
        for (const [id, scope] of this.urlElicitations) {
            if (scope.sessionId === sessionId) this.urlElicitations.delete(id);
        }
    }

    canPublishSession(sessionId: string): boolean {
        return !this.closedSessions.has(sessionId);
    }

    canRequestSession(sessionId: string): boolean {
        return this.canPublishSession(sessionId) && !this.sessionIsClosing(sessionId);
    }

    async notify(method: string, params?: unknown): Promise<void> {
        if (method === acp.methods.client.session.update && isSessionUpdateParams(params)) {
            if (!this.canPublishSession(params.sessionId)) return;
            const update = this.reports.prepare(params.sessionId, params.update);
            if (update === null) return;
            await this.client.notify(method, {...params, update});
            // A fresh announcement reopens a child view after its parent is resumed.
            if (update.sessionUpdate === "subagent_update") this.openSession(update.sessionId);
            if (update.sessionUpdate === "subagent_spawned") this.openSession(update.subagentSessionId);
            return;
        }
        if (method === acp.methods.client.elicitation.complete) {
            const id = (params as {elicitationId?: unknown} | null)?.elicitationId;
            if (typeof id !== "string" || !this.urlElicitations.has(id)) return;
            this.urlElicitations.delete(id);
            await this.sendElicitationCompletion(params);
            return;
        }
        await this.client.notify(method, params);
    }

    async request(method: string, params?: unknown, options?: acp.SendRequestOptions): Promise<unknown> {
        const sessionId = clientRequestSessionId(method, params);
        if (sessionId !== null && !this.canRequestSession(sessionId)) {
            throw acp.RequestError.requestCancelled(undefined, `Session ${sessionId} is closing or closed`);
        }
        if (method !== acp.methods.client.session.requestPermission || !isPermissionRequestParams(params)) {
            return await this.sendRequest(method, params, options);
        }
        // The client merges the request tool call into the stored tool call, like an update.
        // A cancelled or failed request may leave the client without these fields,
        // so the adapter then forgets the open record and sends every field again.
        this.reports.prepare(params.sessionId, {sessionUpdate: "tool_call_update", ...params.toolCall});
        let response: unknown;
        try {
            response = await this.sendRequest(method, params, options);
        } catch (error) {
            this.reports.forgetOpen(params.sessionId, params.toolCall.toolCallId);
            throw error;
        }
        if (isCancelled(response)) this.reports.forgetOpen(params.sessionId, params.toolCall.toolCallId);
        return response;
    }

    /** Withdraw pending UI without waiting for the client to answer the cancelled requests. */
    cancelSessionRequests(sessionId: string): void {
        for (const controller of this.sessionRequests.get(sessionId) ?? []) {
            controller.abort(acp.RequestError.requestCancelled(undefined, `Session ${sessionId} is closing`));
        }
        this.finishSessionSetup(sessionId);
    }

    private sendRequest(method: string, params: unknown, options?: acp.SendRequestOptions): Promise<unknown> {
        const sessionId = clientRequestSessionId(method, params);
        return sessionId === null
            ? this.withElicitationRequest(method, params, () => this.client.request(method, params, options))
            : this.sendSessionRequest(sessionId, method, params, options);
    }

    /** Direct v2 requests and the shared v1-shaped path keep the same URL scope. */
    withElicitationRequest(method: string, params: unknown, send: () => Promise<unknown>): Promise<unknown> {
        const id = urlElicitationId(method, params);
        if (id === null) return send();
        return this.trackUrlRequest(id, clientRequestSessionId(method, params), send);
    }

    private async trackUrlRequest(id: string, sessionId: string | null, send: () => Promise<unknown>): Promise<unknown> {
        const scope = {sessionId};
        this.urlElicitations.set(id, scope);
        try {
            const response = await send();
            if ((response as {action?: unknown} | null)?.action !== "accept") this.forgetUrlElicitation(id, scope);
            return response;
        } catch (error) {
            this.forgetUrlElicitation(id, scope);
            throw error;
        }
    }

    private forgetUrlElicitation(id: string, scope: {sessionId: string | null}): void {
        if (this.urlElicitations.get(id) === scope) this.urlElicitations.delete(id);
    }

    private async sendSessionRequest(sessionId: string, method: string, params: unknown, options?: acp.SendRequestOptions): Promise<unknown> {
        const controller = new AbortController();
        const requests = this.sessionRequests.get(sessionId) ?? new Set<AbortController>();
        this.sessionRequests.set(sessionId, requests);
        requests.add(controller);
        const cancellationSignal = options?.cancellationSignal
            ? AbortSignal.any([options.cancellationSignal, controller.signal])
            : controller.signal;
        try {
            const setup = this.waitForSessionSetup(sessionId, cancellationSignal);
            if (setup) await setup;
            return await this.withElicitationRequest(method, params,
                () => this.client.request(method, params, {...options, cancellationSignal}));
        } finally {
            requests.delete(controller);
            if (requests.size === 0) this.sessionRequests.delete(sessionId);
        }
    }
}

export function clientRequestSessionId(method: string, params: unknown): string | null {
    if (method !== acp.methods.client.elicitation.create && method !== acp.methods.client.session.requestPermission) return null;
    if (params === null || typeof params !== "object") return null;
    const sessionId = (params as {sessionId?: unknown}).sessionId;
    return typeof sessionId === "string" ? sessionId : null;
}

export function clientNotificationSessionId(method: string, params: unknown): string | null {
    if (method !== acp.methods.client.session.update || params === null || typeof params !== "object") return null;
    const sessionId = (params as {sessionId?: unknown}).sessionId;
    return typeof sessionId === "string" ? sessionId : null;
}

function urlElicitationId(method: string, params: unknown): string | null {
    if (method !== acp.methods.client.elicitation.create || params === null || typeof params !== "object") return null;
    const request = params as {mode?: unknown; elicitationId?: unknown};
    return request.mode === "url" && typeof request.elicitationId === "string" ? request.elicitationId : null;
}

function isCancelled(response: unknown): boolean {
    return (response as Partial<acp.RequestPermissionResponse> | null)?.outcome?.outcome === "cancelled";
}

function isPermissionRequestParams(value: unknown): value is acp.RequestPermissionRequest {
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const toolCall = record["toolCall"];
    return typeof record["sessionId"] === "string"
        && toolCall !== null
        && typeof toolCall === "object"
        && typeof (toolCall as Record<string, unknown>)["toolCallId"] === "string";
}

function isSessionUpdateParams(value: unknown): value is SessionUpdateParams {
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return typeof record["sessionId"] === "string"
        && record["update"] !== null
        && typeof record["update"] === "object";
}
