import type {PromptRequest} from "@agentclientprotocol/sdk";
import type {ServerNotification} from "./app-server";
import type {TurnCompletedNotification} from "./app-server/v2";

const ERROR_MESSAGE = "Selected model is at capacity. Please try a different model.";
const CONTINUATION_PROMPT = "Continue from where you left off.";
const RETRY_WINDOWS_SECONDS = [
    [1, 10],
    [1, 30],
    [30, 60],
    [60, 120],
    [120, 300],
] as const;

export interface TurnRetry {
    attempt: number;
    delaySeconds: number;
    title: string;
    warningPublished: boolean;
}

export interface TurnRetryService {
    createRetry(retryAttempt: number): TurnRetry | null;
    shouldRetry(completed: TurnCompletedNotification): boolean;
    wait(
        retry: TurnRetry,
        signal: AbortSignal | undefined,
        shouldCancel: (() => boolean) | undefined,
    ): Promise<boolean>;
    createContinuationRequest(request: PromptRequest): PromptRequest;
    transformNotification(
        notification: ServerNotification,
        currentTurnId: string | null,
        retry: TurnRetry | null,
    ): ServerNotification;
    createWarning(threadId: string, turnId: string, retry: TurnRetry): ServerNotification;
}

export class RetryCapacityService implements TurnRetryService {
    createRetry(retryAttempt: number): TurnRetry | null {
        const window = RETRY_WINDOWS_SECONDS[retryAttempt];
        if (window === undefined) {
            return null;
        }
        const [minimum, maximum] = window;
        const delaySeconds = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
        const unit = delaySeconds === 1 ? "second" : "seconds";
        return {
            attempt: retryAttempt + 1,
            delaySeconds,
            title: `Selected model is at capacity. Retrying in ${delaySeconds} ${unit} `
                + `(${retryAttempt + 1}/${RETRY_WINDOWS_SECONDS.length}).`,
            warningPublished: false,
        };
    }

    shouldRetry(completed: TurnCompletedNotification): boolean {
        return completed.turn.status === "failed" && isCapacityError(completed.turn.error);
    }

    createContinuationRequest(request: PromptRequest): PromptRequest {
        return {
            sessionId: request.sessionId,
            prompt: [{type: "text", text: CONTINUATION_PROMPT}],
        };
    }

    transformNotification(
        notification: ServerNotification,
        currentTurnId: string | null,
        retry: TurnRetry | null,
    ): ServerNotification {
        if (notification.method !== "error"
            || notification.params.willRetry
            || retry === null
            || notification.params.turnId !== currentTurnId
            || !isCapacityError(notification.params.error)) {
            return notification;
        }
        retry.warningPublished = true;
        return {
            method: "error",
            params: {
                ...notification.params,
                willRetry: true,
                error: {...notification.params.error, message: retry.title},
            },
        };
    }

    createWarning(threadId: string, turnId: string, retry: TurnRetry): ServerNotification {
        return {
            method: "error",
            params: {
                threadId,
                turnId,
                willRetry: true,
                error: {
                    message: retry.title,
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: null,
                },
            },
        };
    }

    async wait(
        retry: TurnRetry,
        signal: AbortSignal | undefined,
        shouldCancel: (() => boolean) | undefined,
    ): Promise<boolean> {
        if (signal?.aborted || shouldCancel?.()) {
            return false;
        }
        return await new Promise<boolean>((resolve) => {
            const finish = (completed: boolean) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                resolve(completed);
            };
            const onAbort = () => finish(false);
            const timer = setTimeout(() => finish(!shouldCancel?.()), retry.delaySeconds * 1000);
            signal?.addEventListener("abort", onAbort, {once: true});
        });
    }
}

function isCapacityError(error: {message: string; codexErrorInfo: unknown} | null): boolean {
    return error?.codexErrorInfo === "serverOverloaded" && error.message.trim() === ERROR_MESSAGE;
}
