import {RequestError} from "@agentclientprotocol/sdk/unstable";

export function throwIfRequestCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw RequestError.requestCancelled();
}

/** Stop this caller's wait without abandoning the operation's eventual cleanup. */
export function withRequestCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
        const cancelled = () => {
            signal.removeEventListener("abort", cancelled);
            reject(RequestError.requestCancelled());
        };
        if (signal.aborted) cancelled();
        else signal.addEventListener("abort", cancelled, {once: true});
        void operation.then(value => {
            signal.removeEventListener("abort", cancelled);
            if (signal.aborted) cancelled();
            else resolve(value);
        }, error => {
            signal.removeEventListener("abort", cancelled);
            reject(error);
        });
    });
}
