import type {SendRequestOptions} from "@agentclientprotocol/sdk";
import type {AcpClientConnection} from "../ACPSessionConnection";
import {AppServerConnectionLostError} from "./ConnectionLoss";

/**
 * The ACP client connection for the interactions of one prompt (permission requests, elicitations).
 *
 * When `lost` aborts (the app-server of the prompt died), a pending request is cancelled at the client
 * (`$/cancel_request`, so the dialog can close) and settles at once with {@link AppServerConnectionLostError}.
 * The SDK does not settle a cancelled request by itself; it waits for the client's answer, which a client may never
 * send. Until `lost` aborts, requests behave exactly like requests on `connection`.
 */
export function lossAwareConnection(connection: AcpClientConnection, lost: AbortSignal): AcpClientConnection {
    return {
        notify: ((method: string, params?: unknown) =>
            connection.notify(method as never, params as never)) as AcpClientConnection["notify"],
        request: ((method: string, params?: unknown, options?: SendRequestOptions) => {
            if (lost.aborted) {
                return Promise.reject(new AppServerConnectionLostError("an answer of the ACP client"));
            }
            const cancellationSignal = options?.cancellationSignal
                ? AbortSignal.any([options.cancellationSignal, lost])
                : lost;
            const request = connection.request(method as never, params as never, {...options, cancellationSignal});
            return new Promise((resolve, reject) => {
                const onLost = () => reject(new AppServerConnectionLostError("an answer of the ACP client"));
                lost.addEventListener("abort", onLost, {once: true});
                request.then(
                    value => {
                        lost.removeEventListener("abort", onLost);
                        resolve(value);
                    },
                    error => {
                        lost.removeEventListener("abort", onLost);
                        reject(error);
                    },
                );
            });
        }) as AcpClientConnection["request"],
    };
}
