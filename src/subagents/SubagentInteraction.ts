import {AsyncLocalStorage} from "node:async_hooks";
import type {AcpV2ForegroundState} from "../AcpV2ForegroundState";

type Interaction = {
    sessionId: string;
    signal: AbortSignal;
    foreground?: AcpV2ForegroundState;
    itemId?: string;
    nextToolCallId: (serverName: string) => string;
    beforeRequest: () => Promise<void>;
};

const interactions = new AsyncLocalStorage<Interaction>();

export function runSubagentInteraction<T>(context: Interaction, request: () => Promise<T>): Promise<T> {
    return interactions.run(context, request);
}

export function subagentInteractionSignal(sessionId: string, fallback?: AbortSignal): AbortSignal | undefined {
    const context = interactions.getStore();
    return context?.sessionId === sessionId ? context.signal : fallback;
}

export function subagentToolCallId(sessionId: string, serverName: string): string | undefined {
    const context = interactions.getStore();
    return context?.sessionId === sessionId ? context.nextToolCallId(serverName) : undefined;
}

/** Only requests actually sent to the client count as blocked work. */
export function withSubagentUserAction<T>(
    sessionId: string, request: () => Promise<T>, itemId?: string, signal?: AbortSignal,
): Promise<T> {
    const context = interactions.getStore();
    if (context?.sessionId !== sessionId) return request();
    const cancellation = signal ?? context.signal;
    const send = async (): Promise<T> => {
        cancellation.throwIfAborted();
        await context.beforeRequest();
        cancellation.throwIfAborted();
        let abort!: () => void;
        const cancelled = new Promise<T>((_resolve, reject) => {
            abort = () => reject(cancellation.reason);
            cancellation.addEventListener("abort", abort, {once: true});
        });
        try {
            return await Promise.race([
                Promise.resolve().then(() => {
                    cancellation.throwIfAborted();
                    return request();
                }),
                cancelled,
            ]);
        } finally {
            cancellation.removeEventListener("abort", abort);
        }
    };
    return context.foreground
        ? context.foreground.withUserAction(itemId ?? context.itemId, send, cancellation)
        : send();
}
