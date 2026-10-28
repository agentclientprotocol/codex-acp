import {afterEach, describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import open from "open";
import {CodexAcpClient, type UrlElicitationRequester} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import type {AccountLoginCompletedNotification, LoginAccountParams, LoginAccountResponse} from "../../app-server/v2";
import {AppServerConnectionLostError} from "../../app-server-recovery/ConnectionLoss";
import {createMockConnections} from "./test-utils";

vi.mock("open", () => ({default: vi.fn().mockResolvedValue(undefined)}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return {promise, resolve, reject};
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const methods = ["chat-gpt", "chat-gpt-device-code"] as const;

function createFixture() {
    const mocks = createMockConnections();
    const disposeListeners = new Set<() => void>();
    Object.assign(mocks.mockCodexConnection, {
        onDispose: (listener: () => void) => { disposeListeners.add(listener); },
    });
    mocks.mockCodexConnection.onNotification.mockImplementation((method: string, handler: Function) => {
        mocks.notificationHandlers.set(method, handler);
        return {dispose: () => mocks.notificationHandlers.delete(method)};
    });
    mocks.mockCodexConnection.sendRequest.mockImplementation(async (method: string) => {
        if (method === "account/read") return {account: null, requiresOpenaiAuth: true};
        if (method === "config/read") return {config: {}, origins: {}, layers: []};
        return {};
    });
    const appServer = new CodexAppServerClient(mocks.mockCodexConnection as never);
    let nextId = 0;
    const start = vi.spyOn(appServer, "accountLogin").mockImplementation(async params => response(params, `login-${++nextId}`));
    const cancel = vi.spyOn(appServer, "accountLoginCancel").mockResolvedValue({status: "canceled"});
    const client = new CodexAcpClient(appServer);
    const complete = (loginId: string | null, success: boolean) => {
        mocks.notificationHandlers.get("account/login/completed")?.({
            loginId, success, error: success ? null : "Login cancelled", onboardingEntrypoint: null,
        } satisfies AccountLoginCompletedNotification);
    };
    return {
        client, appServer, start, cancel, complete,
        listening: () => mocks.notificationHandlers.has("account/login/completed"),
        disconnect: () => { for (const listener of disposeListeners) listener(); },
    };
}

function response(params: LoginAccountParams, loginId: string): LoginAccountResponse {
    if (params.type === "chatgpt") return {type: "chatgpt", loginId, authUrl: "https://example.com/login"};
    if (params.type === "apiKey") return {type: "apiKey"};
    return {type: "chatgptDeviceCode", loginId, verificationUrl: "https://example.com/device", userCode: "ABCD"};
}

function elicitation() {
    return {
        elicitUrl: vi.fn<UrlElicitationRequester["elicitUrl"]>().mockImplementation(() => new Promise(() => {})),
        completeElicitation: vi.fn().mockResolvedValue(undefined),
    };
}

afterEach(() => { vi.clearAllMocks(); });

describe("Account login attempts", () => {
    for (const firstMethod of methods) {
        for (const secondMethod of methods) {
            it.each([false, true])(`${firstMethod} then ${secondMethod} ignores the stopped login's success=%s`, async success => {
                const fixture = createFixture();
                const firstSignal = new AbortController();
                const firstUi = elicitation();
                const first = fixture.client.authenticate({methodId: firstMethod}, firstUi, firstSignal.signal);
                const firstResult = expect(first).rejects.toMatchObject({code: -32800});
                await flush();
                firstSignal.abort();
                await firstResult;
                expect(fixture.cancel).toHaveBeenCalledWith({loginId: "login-1"});

                const secondUi = elicitation();
                const settled = vi.fn();
                const second = fixture.client.authenticate({methodId: secondMethod}, secondUi);
                void second.then(settled, settled);
                await flush();
                fixture.complete("login-1", success);
                await flush();
                expect(settled).not.toHaveBeenCalled();
                expect(secondUi.completeElicitation).not.toHaveBeenCalled();
                fixture.complete("login-2", true);
                await expect(second).resolves.toBe(true);
                expect(fixture.listening()).toBe(false);
                expect(fixture.cancel).toHaveBeenCalledTimes(1);
                expect(firstUi.completeElicitation).toHaveBeenCalledTimes(firstMethod === "chat-gpt-device-code" ? 1 : 0);
            });
        }
    }

    it("keeps overlapping attempts separate when the old request has not been cancelled", async () => {
        const fixture = createFixture();
        const first = fixture.client.authenticate({methodId: "chat-gpt"});
        await flush();
        const settled = vi.fn();
        const second = fixture.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation());
        void second.then(settled, settled);
        await flush();
        fixture.complete("login-1", false);
        await expect(first).resolves.toBe(false);
        expect(settled).not.toHaveBeenCalled();
        expect(fixture.listening()).toBe(true);
        fixture.complete("login-2", true);
        await expect(second).resolves.toBe(true);
        expect(fixture.listening()).toBe(false);
    });

    it("matches an early completion after the start response supplies the login ID", async () => {
        const fixture = createFixture();
        const started = deferred<LoginAccountResponse>();
        fixture.start.mockReturnValueOnce(started.promise);
        const login = fixture.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation());
        await flush();
        fixture.complete("old-login", false);
        fixture.complete("early-login", true);
        started.resolve(response({type: "chatgptDeviceCode"}, "early-login"));
        await expect(login).resolves.toBe(true);
        expect(fixture.cancel).not.toHaveBeenCalled();
    });

    it("cancels a late start response without opening its browser or cancelling the next login", async () => {
        const fixture = createFixture();
        const started = deferred<LoginAccountResponse>();
        fixture.start.mockReturnValueOnce(started.promise);
        const signal = new AbortController();
        const first = fixture.client.authenticate({methodId: "chat-gpt"}, undefined, signal.signal);
        const cancelled = expect(first).rejects.toMatchObject({code: -32800});
        await flush();
        signal.abort();
        await cancelled;
        expect(fixture.listening()).toBe(false);

        const second = fixture.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation());
        await flush();
        started.resolve(response({type: "chatgpt"}, "late-login"));
        await flush();
        expect(open).not.toHaveBeenCalled();
        expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "late-login"});
        fixture.complete("login-1", true);
        await expect(second).resolves.toBe(true);
    });

    it("cleans up after a browser launch failure and permits a device code retry", async () => {
        const fixture = createFixture();
        vi.mocked(open).mockRejectedValueOnce(new Error("spawn xdg-open ENOENT"));
        await expect(fixture.client.authenticate({methodId: "chat-gpt"})).rejects.toThrow("spawn xdg-open ENOENT");
        expect(fixture.listening()).toBe(false);
        expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "login-1"});
        const second = fixture.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation());
        await flush();
        fixture.complete("login-1", false);
        fixture.complete("login-2", true);
        await expect(second).resolves.toBe(true);
    });

    it("ends the login and its elicitation when the app-server disconnects", async () => {
        const fixture = createFixture();
        const ui = elicitation();
        const login = fixture.client.authenticate({methodId: "chat-gpt-device-code"}, ui);
        const failed = expect(login).rejects.toBeInstanceOf(AppServerConnectionLostError);
        await flush();
        fixture.disconnect();
        await failed;
        expect(fixture.listening()).toBe(false);
        expect(ui.completeElicitation).toHaveBeenCalledOnce();
        expect(fixture.cancel).not.toHaveBeenCalled();
    });

    it("does not start a login with an already cancelled signal", async () => {
        const fixture = createFixture();
        await expect(fixture.client.authenticate({methodId: "chat-gpt"}, undefined, AbortSignal.abort()))
            .rejects.toMatchObject({code: -32800});
        expect(fixture.start).not.toHaveBeenCalled();
        expect(fixture.listening()).toBe(false);
    });

    it("preserves API key completions with a null login ID", async () => {
        const fixture = createFixture();
        const login = fixture.client.authenticate({methodId: "api-key", _meta: {"api-key": {apiKey: "test-key"}}});
        await flush();
        fixture.complete("old-browser-login", false);
        fixture.complete(null, true);
        await expect(login).resolves.toBe(true);
        expect(fixture.cancel).not.toHaveBeenCalled();
    });

    it("removes the listener when the login start fails", async () => {
        const fixture = createFixture();
        fixture.start.mockRejectedValueOnce(new Error("start failed"));
        await expect(fixture.client.authenticate({methodId: "chat-gpt"})).rejects.toThrow("start failed");
        expect(fixture.listening()).toBe(false);
    });
});

describe.each([1, 2] as const)("Authentication cancellation over ACP v%s", version => {
    it.each(methods)("cancels %s and permits another login on the same connection", async methodId => {
        const fixture = createFixture();
        const router = createAcpAgentRouter(connection => new CodexAcpServer(connection, fixture.client));
        const toAgent = new TransformStream<Uint8Array, Uint8Array>();
        const toClient = new TransformStream<Uint8Array, Uint8Array>();
        router.connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
        async function connect() {
            const stream = acp.ndJsonStream(toAgent.writable, toClient.readable);
            const waitForCancellation = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(acp.RequestError.requestCancelled()), {once: true});
            });
            if (version === 1) {
                const connection = acp.client({name: "auth-test"})
                    .onRequest(acp.methods.client.elicitation.create, ctx => waitForCancellation(ctx.signal))
                    .connect(stream);
                await connection.agent.request(acp.methods.agent.initialize, {
                    protocolVersion: 1, clientCapabilities: {elicitation: {url: {}}},
                });
                return {
                    login: (signal?: AbortSignal) => connection.agent.request(acp.methods.agent.authenticate, {methodId},
                        signal ? {cancellationSignal: signal} : undefined),
                    close: () => connection.close(),
                };
            }
            const connection = acpV2.client({name: "auth-test"})
                .onRequest(acpV2.methods.client.elicitation.create, ctx => waitForCancellation(ctx.signal))
                .connect(stream);
            await connection.agent.request(acpV2.methods.agent.initialize, {
                protocolVersion: 2, info: {name: "auth-test", version: "1"}, capabilities: {elicitation: {url: {}}},
            });
            return {
                login: (signal?: AbortSignal) => connection.agent.request(acpV2.methods.agent.auth.login, {methodId},
                    signal ? {cancellationSignal: signal} : undefined),
                close: () => connection.close(),
            };
        }
        const connection = await connect();
        try {
            const signal = new AbortController();
            const first = connection.login(signal.signal);
            const cancelled = expect(first).rejects.toMatchObject({code: -32800});
            await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce());
            signal.abort();
            await cancelled;
            expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "login-1"});
            const second = connection.login();
            await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(2));
            fixture.complete("login-1", false);
            await flush();
            fixture.complete("login-2", true);
            await expect(second).resolves.toEqual({});
        } finally {
            connection.close();
        }
    });
});
