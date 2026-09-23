import * as acp from "@agentclientprotocol/sdk";
import type {AcpClientConnection, UpdateSessionEvent} from "./ACPSessionConnection";
import {ToolCallReports} from "./ToolCallReports";

type SessionUpdateParams = {sessionId: string; update: UpdateSessionEvent};

/**
 * Sends the notifications and requests of the adapter to the ACP client.
 *
 * Every emission site of the adapter uses this connection.
 * So each tool call report goes through the same changed-fields filter,
 * whether it comes from a live event, a history replay, a permission flow or an async task.
 */
export class ToolCallReportingConnection {
    readonly reports = new ToolCallReports();

    constructor(private readonly client: AcpClientConnection) {}

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
            return await this.client.request(method, params, options);
        }
        // The client merges the request tool call into the stored tool call, like an update.
        // A cancelled or failed request may leave the client without these fields,
        // so the adapter then forgets the open record and sends every field again.
        this.reports.prepare(params.sessionId, {sessionUpdate: "tool_call_update", ...params.toolCall});
        let response: unknown;
        try {
            response = await this.client.request(method, params, options);
        } catch (error) {
            this.reports.forgetOpen(params.sessionId, params.toolCall.toolCallId);
            throw error;
        }
        if (isCancelled(response)) this.reports.forgetOpen(params.sessionId, params.toolCall.toolCallId);
        return response;
    }
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
