import {afterEach, describe, expect, it, vi} from "vitest";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {CodexAppServerClient} from "../CodexAppServerClient";

/** A connection whose every request stays pending, like the app-server of a wedged process. */
function silentConnection(sendRequest: () => unknown = () => new Promise(() => {})): MessageConnection {
    return {
        sendRequest,
        onUnhandledNotification: () => {},
        onNotification: () => {},
        onRequest: () => {},
        onDispose: () => {},
        dispose: () => {},
        end: () => {},
    } as unknown as MessageConnection;
}

describe("app-server request deadlines", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it("fails a request the app-server never answers", async () => {
        vi.useFakeTimers();
        const client = new CodexAppServerClient(silentConnection());

        const request = client.listModels({});
        const assertion = expect(request).rejects.toThrow("Codex did not answer model/list within 60 s");

        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
    });

    it("gives turn/interrupt a shorter deadline than other requests", async () => {
        vi.useFakeTimers();
        const client = new CodexAppServerClient(silentConnection());

        const interrupt = client.turnInterrupt({threadId: "thread-id", turnId: "turn-id"});
        const assertion = expect(interrupt).rejects.toThrow("Codex did not answer turn/interrupt within 15 s");

        await vi.advanceTimersByTimeAsync(15_000);
        await assertion;
    });

    it("honors CODEX_RPC_TIMEOUT_MS", async () => {
        vi.useFakeTimers();
        vi.stubEnv("CODEX_RPC_TIMEOUT_MS", "2500");
        const client = new CodexAppServerClient(silentConnection());

        const request = client.listModels({});
        const assertion = expect(request).rejects.toThrow("Codex did not answer model/list within 3 s");

        await vi.advanceTimersByTimeAsync(2500);
        await assertion;
    });

    it("settles a request whose connection double returns a plain value", async () => {
        const client = new CodexAppServerClient(silentConnection(() => undefined));

        await expect(client.listModels({})).resolves.toBeUndefined();
    });
});
