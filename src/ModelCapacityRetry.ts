import type {PromptRequest} from "@agentclientprotocol/sdk";
import type {ServerNotification} from "./app-server";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {TurnCompletedNotification} from "./app-server/v2";
import type {AgentMode} from "./AgentMode";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {CodexEventHandler} from "./CodexEventHandler";
import {logger} from "./Logger";
import type {ModelId} from "./ModelId";

const ERROR_MESSAGE = "Selected model is at capacity. Please try a different model.";
const CONTINUATION_PROMPT = "Continue from where you left off.";
const RETRY_WINDOWS_SECONDS = [
    [1, 10],
    [1, 30],
    [30, 60],
    [60, 120],
    [120, 300],
] as const;

interface ModelCapacityRetryAttempt {
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

class ModelCapacityRetryController {
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

interface ActivePromptRuntime {
    signal: AbortSignal;
    closeSignal: Promise<null>;
    currentTurn: {threadId: string; turnId: string} | null;
}

interface ModelCapacitySessionRuntime {
    currentTurnId: string | null;
    cwd: string;
    additionalDirectories: string[];
}

interface CodexModelCapacityRetryRunnerOptions {
    sessionId: string;
    activePrompt: ActivePromptRuntime;
    sessionState: ModelCapacitySessionRuntime;
    codexAcpClient: CodexAcpClient;
    eventHandler: CodexEventHandler;
    agentMode: AgentMode;
    modelId: ModelId;
    serviceTier: ServiceTier | null;
    disableSummary: boolean;
    runWithProcessCheck<T>(operation: () => Promise<T>): Promise<T>;
    shouldStop(): boolean;
    isActivePrompt(): boolean;
    interruptLateStartedTurn(turn: {threadId: string; turnId: string}): void;
    cancelBeforeTurnStarted(): Promise<null>;
    ensurePendingTurnStart(): void;
    resolvePendingTurnStart(turnId: string): void;
    preparePendingTurnStart(): void;
    setPromptNotificationsActive(active: boolean): void;
    snapshotRecoverableSessionFailure(): void;
    onTurnStarted: (() => void) | undefined;
}

interface RunOptions {
    notifyOnTurnStarted: boolean;
    notificationsActiveBeforeStart: boolean;
}

export class CodexModelCapacityRetryRunner {
    private readonly retry = new ModelCapacityRetryController();

    constructor(private readonly options: CodexModelCapacityRetryRunnerOptions) {}

    transformNotification(notification: ServerNotification, currentTurnId: string | null): ServerNotification {
        return this.retry.transformNotification(notification, currentTurnId);
    }

    async run(initialRequest: PromptRequest, runOptions: RunOptions): Promise<TurnCompletedNotification | null> {
        const options = this.options;
        return await this.retry.run(initialRequest, {
            signal: options.activePrompt.signal,
            shouldStop: options.shouldStop,
            runTurn: async (turnRequest, retryAttempt) => {
                options.setPromptNotificationsActive(
                    retryAttempt === 0 ? runOptions.notificationsActiveBeforeStart : true,
                );
                options.ensurePendingTurnStart();
                const sendPromptPromise = options.runWithProcessCheck(() => options.codexAcpClient.sendPrompt(
                    turnRequest,
                    options.agentMode,
                    options.modelId,
                    options.serviceTier,
                    options.disableSummary,
                    options.sessionState.cwd,
                    options.sessionState.additionalDirectories,
                    (turnId) => {
                        const turn = {threadId: options.sessionId, turnId};
                        options.activePrompt.currentTurn = turn;
                        if (options.shouldStop()) {
                            options.interruptLateStartedTurn(turn);
                            return;
                        }
                        options.sessionState.currentTurnId = turnId;
                        if (!runOptions.notificationsActiveBeforeStart && retryAttempt === 0) {
                            options.snapshotRecoverableSessionFailure();
                        }
                        options.setPromptNotificationsActive(true);
                        this.retry.markTurnStarted(turnId);
                        options.resolvePendingTurnStart(turnId);
                        if (runOptions.notifyOnTurnStarted && retryAttempt === 0) {
                            options.onTurnStarted?.();
                        }
                    },
                    options.shouldStop,
                ));
                void sendPromptPromise.catch((error) => {
                    if (!options.isActivePrompt()) {
                        logger.error(`Prompt for cancelled session ${options.sessionId} failed after prompt returned`, error);
                    }
                });
                return await Promise.race([
                    sendPromptPromise,
                    options.activePrompt.closeSignal,
                    options.cancelBeforeTurnStarted(),
                ]);
            },
            afterTurn: async () => {
                await options.codexAcpClient.waitForSessionNotifications(options.sessionId);
                await options.eventHandler.flushPendingErrors();
            },
            onFinalTurn: async (completed) => {
                await options.eventHandler.handleFailedTurn(completed.turn);
                options.setPromptNotificationsActive(false);
            },
            onRetry: async (completed, retry) => {
                if (!retry.warningPublished) {
                    await options.eventHandler.publishModelCapacityRetryWarning(completed.turn.id, retry.title);
                }
                await options.eventHandler.flushPendingPlanUpdates();
                options.snapshotRecoverableSessionFailure();
                options.activePrompt.currentTurn = null;
                options.sessionState.currentTurnId = null;
                options.preparePendingTurnStart();
                logger.log("Selected model is at capacity; scheduling retry", {
                    sessionId: options.sessionId,
                    attempt: retry.attempt,
                    delaySeconds: retry.delaySeconds,
                });
            },
        });
    }
}

function isModelCapacityError(error: {message: string; codexErrorInfo: unknown} | null): boolean {
    return error?.codexErrorInfo === "serverOverloaded" && error.message.trim() === ERROR_MESSAGE;
}
