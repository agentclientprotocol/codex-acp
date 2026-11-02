import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {AccountLoginCompletedNotification, LoginAccountParams, LoginAccountResponse} from "./app-server/v2";
import {throwIfRequestCancelled, withRequestCancellation} from "./RequestCancellation";
import {logger} from "./Logger";

/** One native login owns its completion listener and any interactive login ID. */
export async function runAccountLogin(
    client: CodexAppServerClient,
    params: LoginAccountParams,
    show: (response: LoginAccountResponse) => Promise<boolean>,
    signal?: AbortSignal,
): Promise<boolean> {
    throwIfRequestCancelled(signal);
    let expectedId: string | null | undefined;
    const buffered: AccountLoginCompletedNotification[] = [];
    let complete!: (event: AccountLoginCompletedNotification) => void;
    let endWait!: (error: Error) => void;
    const notified = new Promise<AccountLoginCompletedNotification>((resolve, reject) => {
        complete = resolve;
        endWait = reject;
    });
    const accept = (event: AccountLoginCompletedNotification) => {
        if (expectedId === undefined) buffered.push(event);
        else if ((event.loginId ?? null) === expectedId) complete(event);
    };
    const listener = client.connection.onNotification("account/login/completed", accept);
    const completed = client.waitWhileConnected("account/login/completed", notified);
    void completed.catch(() => {});
    let response: LoginAccountResponse | null = null;
    let finished = false;
    try {
        // Keep ownership until a late start response can be cancelled by its own ID.
        response = await client.accountLogin(params);
        expectedId = "loginId" in response ? response.loginId : null;
        for (const event of buffered) accept(event);
        buffered.length = 0;
        throwIfRequestCancelled(signal);
        const first = await withRequestCancellation(Promise.race([
            completed.then(result => ({type: "completed" as const, result})),
            show(response).then(accepted => ({type: "shown" as const, accepted})),
        ]), signal);
        if (first.type === "completed") {
            finished = true;
            return first.result.success;
        }
        if (!first.accepted) return false;
        const result = await withRequestCancellation(completed, signal);
        finished = true;
        return result.success;
    } finally {
        if (!finished && response && "loginId" in response) {
            await client.accountLoginCancel({loginId: response.loginId}).catch(error => {
                logger.error("Failed to cancel Codex account login", error);
            });
        } else if (signal?.aborted && response && expectedId === null) {
            // API-key completions have no ID. Drain this one before another login can start.
            await completed.catch(() => {});
        }
        endWait(new Error("Account login has ended"));
        listener.dispose();
    }
}
