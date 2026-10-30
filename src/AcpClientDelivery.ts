import * as acp from "@agentclientprotocol/sdk/unstable";
import type {AcpClientConnection, UpdateSessionEvent} from "./ACPSessionConnection";
import {ToolCallReports} from "./ToolCallReports";

type SessionUpdateParams = {sessionId: string; update: UpdateSessionEvent};

/**
 * Sends the notifications and requests of the adapter to the ACP client.
 *
 * Every emission site of the adapter uses this connection.
 * Tool reports share a changed-fields filter, and session interactions share cancellation
 * on close, whether they belong to foreground work, background work or session startup.
 */
export class AcpClientDelivery {
    readonly reports = new ToolCallReports();
    private readonly sessionRequests = new Map<string, Set<AbortController>>();

    constructor(
        private readonly client: AcpClientConnection,
        private readonly sessionIsClosing: (sessionId: string) => boolean = () => false,
    ) {}

    /** Returns this connection with the signature of the SDK connection. */
    asClientConnection(): AcpClientConnection {
        return this as unknown as AcpClientConnection;
    }

    async notify(method: string, params?: unknown): Promise<void> {
        if (method === acp.methods.client.session.update && isSessionUpdateParams(params)) {
            const update = this.reports.prepare(params.sessionId, params.update);
            if (update === null) return;
            await this.client.notify(method, {...params, update});
            return;
        }
        await this.client.notify(method, params);
    }

    async request(method: string, params?: unknown, options?: acp.SendRequestOptions): Promise<unknown> {
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
    }

    private async sendRequest(method: string, params: unknown, options?: acp.SendRequestOptions): Promise<unknown> {
        const sessionId = interactionSessionId(method, params);
        if (sessionId === null) return await this.client.request(method, params, options);
        if (this.sessionIsClosing(sessionId)) {
            throw acp.RequestError.requestCancelled(undefined, `Session ${sessionId} is closing`);
        }
        const controller = new AbortController();
        const requests = this.sessionRequests.get(sessionId) ?? new Set<AbortController>();
        this.sessionRequests.set(sessionId, requests);
        requests.add(controller);
        const cancellationSignal = options?.cancellationSignal
            ? AbortSignal.any([options.cancellationSignal, controller.signal])
            : controller.signal;
        try {
            return await this.client.request(method, params, {...options, cancellationSignal});
        } finally {
            requests.delete(controller);
            if (requests.size === 0) this.sessionRequests.delete(sessionId);
        }
    }
}

function interactionSessionId(method: string, params: unknown): string | null {
    if (method !== acp.methods.client.elicitation.create && method !== acp.methods.client.session.requestPermission) return null;
    if (params === null || typeof params !== "object") return null;
    const sessionId = (params as {sessionId?: unknown}).sessionId;
    return typeof sessionId === "string" ? sessionId : null;
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
