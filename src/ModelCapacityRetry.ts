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

export interface ModelCapacityRetryAttempt {
    attempt: number;
    delaySeconds: number;
    title: string;
    turnId: string | null;
    warningPublished: boolean;
}

interface ModelCapacityRetryHooks {
    signal: AbortSignal;
    shouldStop(): boolean;
    runTurn(request: PromptRequest, retryAttempt: number): Promise<TurnCompletedNotification | null>;
    afterTurn(completed: TurnCompletedNotification): Promise<void>;
    onRetry(completed: TurnCompletedNotification, retry: ModelCapacityRetryAttempt): Promise<void>;
    onFinalTurn(completed: TurnCompletedNotification): Promise<void>;
}

export class ModelCapacityRetryController {
    private activeRetry: ModelCapacityRetryAttempt | null = null;

    async run(initialRequest: PromptRequest, hooks: ModelCapacityRetryHooks): Promise<TurnCompletedNotification | null> {
        let request = initialRequest;
        for (let retryAttempt = 0; ; retryAttempt++) {
            this.activeRetry = this.createRetry(retryAttempt);
            const completed = await hooks.runTurn(request, retryAttempt);
            if (completed === null) {
                this.activeRetry = null;
                return null;
            }

            await hooks.afterTurn(completed);
            const retry = this.activeRetry;
            if (retry === null
                || retry.turnId !== completed.turn.id
                || completed.turn.status !== "failed"
                || !isModelCapacityError(completed.turn.error)) {
                this.activeRetry = null;
                await hooks.onFinalTurn(completed);
                return completed;
            }

            await hooks.onRetry(completed, retry);
            if (!await this.waitForRetry(retry.delaySeconds, hooks)) {
                this.activeRetry = null;
                return null;
            }
            request = {
                sessionId: initialRequest.sessionId,
                prompt: [{type: "text", text: CONTINUATION_PROMPT}],
            };
        }
    }

    markTurnStarted(turnId: string): void {
        if (this.activeRetry !== null) {
            this.activeRetry.turnId = turnId;
        }
    }

    transformNotification(notification: ServerNotification, currentTurnId: string | null): ServerNotification {
        if (notification.method !== "error"
            || notification.params.willRetry
            || !isModelCapacityError(notification.params.error)
            || this.activeRetry === null
            || notification.params.turnId !== currentTurnId) {
            return notification;
        }
        this.activeRetry.warningPublished = true;
        return {
            method: "error",
            params: {
                ...notification.params,
                willRetry: true,
                error: {
                    ...notification.params.error,
                    message: this.activeRetry.title,
                },
            },
        };
    }

    private createRetry(retryAttempt: number): ModelCapacityRetryAttempt | null {
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
            turnId: null,
            warningPublished: false,
        };
    }

    private async waitForRetry(delaySeconds: number, hooks: ModelCapacityRetryHooks): Promise<boolean> {
        if (hooks.shouldStop()) {
            return false;
        }
        return await new Promise<boolean>((resolve) => {
            const finish = (completed: boolean) => {
                clearTimeout(timer);
                hooks.signal.removeEventListener("abort", onAbort);
                resolve(completed);
            };
            const onAbort = () => finish(false);
            const timer = setTimeout(() => finish(true), delaySeconds * 1000);
            hooks.signal.addEventListener("abort", onAbort, {once: true});
        });
    }
}

function isModelCapacityError(error: {message: string; codexErrorInfo: unknown} | null): boolean {
    return error?.codexErrorInfo === "serverOverloaded" && error.message.trim() === ERROR_MESSAGE;
}
