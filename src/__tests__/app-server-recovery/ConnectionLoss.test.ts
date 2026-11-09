import {describe, expect, it, vi} from "vitest";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAcpClient} from "../../CodexAcpClient";
import {AppServerConnectionLostError} from "../../app-server-recovery/ConnectionLoss";

/** A connection whose `dispose()` fires `onDispose`, like vscode-jsonrpc when the Codex process exits. */
function fakeConnection(sendRequest: (method: string, params?: unknown) => Promise<unknown> = async () => undefined) {
    const disposeListeners = new Set<() => void>();
    const notificationListeners = new Map<string, Set<(params: unknown) => void>>();
    const connection = {
        sendRequest: vi.fn(sendRequest),
        onUnhandledNotification: () => {},
        onNotification: (method: string, handler: (params: unknown) => void) => {
            const listeners = notificationListeners.get(method) ?? new Set();
            listeners.add(handler);
            notificationListeners.set(method, listeners);
            return {dispose: () => listeners.delete(handler)};
        },
        onRequest: () => {},
        onDispose: (listener: () => void) => {
            disposeListeners.add(listener);
            return {dispose: () => disposeListeners.delete(listener)};
        },
        dispose: () => [...disposeListeners].forEach(listener => listener()),
    } as unknown as MessageConnection;
    return {connection, notificationListeners};
}

describe("ConnectionLoss", () => {
    it("rejects a turn wait when the connection is disposed and forgets its resolver", async () => {
        const {connection} = fakeConnection();
        const client = new CodexAppServerClient(connection);
        const turn = client.awaitTurnCompleted("thread-1", "turn-1");

        connection.dispose();

        await expect(turn).rejects.toBeInstanceOf(AppServerConnectionLostError);
        await expect(turn).rejects.toThrow("while waiting for the end of the turn");
        expect((client as unknown as {pendingTurnCompletionResolvers: Map<string, unknown>}).pendingTurnCompletionResolvers.size).toBe(0);
    });

    it("rejects a wait that starts after the connection is gone", async () => {
        const {connection} = fakeConnection();
        const client = new CodexAppServerClient(connection);
        connection.dispose();

        await expect(client.awaitCompactionCompleted("thread-1")).rejects.toBeInstanceOf(AppServerConnectionLostError);
        expect((client as unknown as {pendingCompactionCompletionResolvers: Map<string, unknown>}).pendingCompactionCompletionResolvers.size).toBe(0);
    });

    it("rejects a running turn of runTurn and settles before the next notification", async () => {
        const {connection} = fakeConnection(async (method) => method === "turn/start" ? {turn: {id: "turn-1"}} : undefined);
        const client = new CodexAppServerClient(connection);
        const turn = client.runTurn({threadId: "thread-1", input: []} as never);
        await vi.waitFor(() => expect(connection.sendRequest).toHaveBeenCalledWith("turn/start", expect.anything()));
        await Promise.resolve();

        connection.dispose();

        await expect(turn).rejects.toBeInstanceOf(AppServerConnectionLostError);
    });

    it("removes its listener when a wait ends normally", async () => {
        const {connection} = fakeConnection();
        const client = new CodexAppServerClient(connection);
        const listeners = (client.connectionLoss as unknown as {listeners: Set<unknown>}).listeners;

        await expect(client.waitWhileConnected("x", Promise.resolve(1))).resolves.toBe(1);
        await expect(client.waitWhileConnected("x", Promise.reject(new Error("boom")))).rejects.toThrow("boom");

        expect(listeners.size).toBe(0);
    });

    it("ends a login wait when the connection is lost after the login request failed", async () => {
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            const {connection, notificationListeners} = fakeConnection(async (method) => {
                if (method === "account/login/start") throw new Error("login failed");
                return undefined;
            });
            const acpClient = new CodexAcpClient(new CodexAppServerClient(connection));

            await expect(acpClient.authenticate({
                methodId: "api-key",
                _meta: {"api-key": {apiKey: "sk-test"}},
            } as never)).rejects.toThrow("login failed");
            connection.dispose();
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(unhandled).not.toHaveBeenCalled();
            expect(notificationListeners.get("account/login/completed")?.size ?? 0).toBe(0);
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });
});
