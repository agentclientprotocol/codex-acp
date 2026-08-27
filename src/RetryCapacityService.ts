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

export interface CapacityRetry {
    attempt: number;
    delaySeconds: number;
    title: string;
    warningPublished: boolean;
}

interface RetryCapacityOptions {
    signal: AbortSignal | undefined;
    shouldCancel: (() => boolean) | undefined;
    runTurn(request: PromptRequest, retry: CapacityRetry | null): Promise<TurnCompletedNotification | null>;
    onRetry: ((completed: TurnCompletedNotification, retry: CapacityRetry) => Promise<void>) | undefined;
}

class CapacityRetryError extends Error {
    constructor(
        readonly completed: TurnCompletedNotification,
        readonly retry: CapacityRetry,
    ) {
        super(retry.title);
    }
}

export class RetryCapacityService {
    async run(
        request: PromptRequest,
        options: RetryCapacityOptions,
        retryAttempt = 0,
    ): Promise<TurnCompletedNotification | null> {
        if (options.signal?.aborted || options.shouldCancel?.()) {
            return null;
        }
        const retry = this.createRetry(retryAttempt);
        try {
            const completed = await options.runTurn(request, retry);
            if (completed === null) {
                return null;
            }
            if (retry !== null && completed.turn.status === "failed" && isCapacityError(completed.turn.error)) {
                throw new CapacityRetryError(completed, retry);
            }
            return completed;
        } catch (error) {
            if (!(error instanceof CapacityRetryError)) {
                throw error;
            }
            await options.onRetry?.(error.completed, error.retry);
            if (!await this.wait(error.retry.delaySeconds, options)) {
                return null;
            }
            return await this.run({
                sessionId: request.sessionId,
                prompt: [{type: "text", text: CONTINUATION_PROMPT}],
            }, options, retryAttempt + 1);
        }
    }

    transformNotification(
        notification: ServerNotification,
        currentTurnId: string | null,
        retry: CapacityRetry | null,
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

    createWarning(threadId: string, turnId: string, retry: CapacityRetry): ServerNotification {
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

    private createRetry(retryAttempt: number): CapacityRetry | null {
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

    private async wait(delaySeconds: number, options: RetryCapacityOptions): Promise<boolean> {
        if (options.signal?.aborted || options.shouldCancel?.()) {
            return false;
        }
        return await new Promise<boolean>((resolve) => {
            const finish = (completed: boolean) => {
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
                resolve(completed);
            };
            const onAbort = () => finish(false);
            const timer = setTimeout(() => finish(!options.shouldCancel?.()), delaySeconds * 1000);
            options.signal?.addEventListener("abort", onAbort, {once: true});
        });
    }
}

function isCapacityError(error: {message: string; codexErrorInfo: unknown} | null): boolean {
    return error?.codexErrorInfo === "serverOverloaded" && error.message.trim() === ERROR_MESSAGE;
}
