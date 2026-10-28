import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {Disposable} from "vscode-jsonrpc";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {AccountLoginCompletedNotification, LoginAccountParams, LoginAccountResponse} from "./app-server/v2";
import {AppServerConnectionLostError} from "./app-server-recovery/ConnectionLoss";
import {logger} from "./Logger";

/** Runs account logins with a separate completion and cancellation scope for each request. */
export class AccountLogin {
    private readonly waiters = new Set<(event: AccountLoginCompletedNotification) => void>();
    private subscription: Disposable | undefined;

    constructor(private readonly client: CodexAppServerClient) {}

    async run<T>(
        params: LoginAccountParams,
        authenticate: (response: LoginAccountResponse, completed: Promise<AccountLoginCompletedNotification>) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (signal?.aborted) throw RequestError.requestCancelled();
        if (this.client.connectionLoss.lost) throw new AppServerConnectionLostError("sign-in");

        let loginId: string | null | undefined;
        let ended = false;
        let loginCompleted = false;
        let cancelSent = false;
        const earlyEvents = new Map<string | null, AccountLoginCompletedNotification>();
        let resolveCompleted!: (event: AccountLoginCompletedNotification) => void;
        let rejectCompleted!: (error: unknown) => void;
        const completed = new Promise<AccountLoginCompletedNotification>((resolve, reject) => {
            resolveCompleted = resolve;
            rejectCompleted = reject;
        });
        // The start response or browser launch can fail before the caller awaits completion.
        void completed.catch(() => {});
        let rejectStopped!: (error: unknown) => void;
        const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
        const stop = (error: unknown) => {
            ended = true;
            rejectCompleted(error);
            rejectStopped(error);
        };
        const onAbort = () => stop(RequestError.requestCancelled());
        const onCompleted = (event: AccountLoginCompletedNotification) => {
            if (ended) return;
            if (loginId === undefined) {
                earlyEvents.set(event.loginId, event);
            } else if (event.loginId === loginId) {
                loginCompleted = true;
                resolveCompleted(event);
            }
        };
        const cancelLogin = () => {
            if (typeof loginId !== "string" || loginCompleted || cancelSent || this.client.connectionLoss.lost) return;
            cancelSent = true;
            void this.client.accountLoginCancel({loginId}).catch(error => {
                logger.log("Could not cancel the account login", {error: String(error)});
            });
        };

        this.waiters.add(onCompleted);
        if (this.waiters.size === 1) {
            this.subscription = this.client.connection.onNotification("account/login/completed", event => {
                for (const waiter of this.waiters) waiter(event);
            });
        }
        signal?.addEventListener("abort", onAbort, {once: true});
        const removeLossListener = this.client.connectionLoss.onLost(() => stop(new AppServerConnectionLostError("sign-in")));

        const operation = async () => {
            const response = await this.client.accountLogin(params);
            loginId = "loginId" in response ? response.loginId : null;
            if (ended) {
                cancelLogin();
                throw RequestError.requestCancelled();
            }
            const earlyEvent = earlyEvents.get(loginId);
            earlyEvents.clear();
            if (earlyEvent) onCompleted(earlyEvent);
            return await authenticate(response, completed);
        };
        try {
            return await Promise.race([operation(), stopped]);
        } finally {
            ended = true;
            rejectCompleted(RequestError.requestCancelled());
            earlyEvents.clear();
            signal?.removeEventListener("abort", onAbort);
            removeLossListener();
            this.waiters.delete(onCompleted);
            if (this.waiters.size === 0) {
                this.subscription?.dispose();
                this.subscription = undefined;
            }
            cancelLogin();
        }
    }
}
