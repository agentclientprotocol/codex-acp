import {describe, expect, it, vi} from "vitest";
import open from "open";
import type {CodexAcpServer} from "../../CodexAcpServer";
import {connectSession, type PromptSession} from "./v2-prompt-harness";

vi.mock("open", () => ({default: vi.fn().mockResolvedValue(undefined)}));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return {promise, resolve};
}

function loginResponse(loginId = "login-1") {
    return {type: "chatgptDeviceCode", loginId, verificationUrl: "https://example.com/device", userCode: "1234"};
}

function complete(h: PromptSession, loginId: string | null) {
    h.emit({method: "account/login/completed", params: {
        loginId, success: true, error: null, onboardingEntrypoint: null,
    }});
}

function cancelledResponse(h: PromptSession) {
    return h.wireMessages.findIndex(frame => "error" in frame && frame.error.code === -32800);
}

describe.each([1, 2] as const)("ACP v%s auth request lifetime", version => {
    const method = version === 1 ? "authenticate" : "auth/login";
    const capabilities = {elicitation: {url: {}}};

    it("holds initial auth publication and account events until initialize is written", async () => {
        const writing = deferred();
        const release = deferred();
        let agent!: CodexAcpServer;
        let notifications: unknown[][] = [];
        const connecting = connectSession(version, {
            beforeInitializeResponseWrite: async () => { writing.resolve(); await release.promise; },
            onAgent: current => {
                agent = current;
                // @ts-expect-error Inspect the actual client send boundary.
                notifications = vi.spyOn(current.connection, "notify").mock.calls;
            },
        });
        let h: PromptSession | null = null;
        try {
            await writing.promise;
            agent.handleAccountUpdated({authMode: "apikey", planType: null});
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(notifications.filter(call => call[0] === "_auth/status_update")).toEqual([]);
            release.resolve();
            h = await connecting;
            await vi.waitFor(() => expect(notifications.some(call => call[0] === "_auth/status_update")).toBe(true));
            const initialized = h.wireMessages.findIndex(frame => "result" in frame && frame.result !== null
                && typeof frame.result === "object" && "protocolVersion" in frame.result);
            const status = h.wireMessages.findIndex(frame => "method" in frame && frame.method.includes("auth/status_update"));
            expect(initialized).toBeGreaterThanOrEqual(0);
            expect(status).toBeGreaterThan(initialized);
        } finally {
            release.resolve();
            (h ?? await connecting).connection.close();
        }
    });

    it.each(["pending", "accepted"] as const)("dismisses a %s URL interaction before the cancelled login response", async state => {
        const uiSignals: AbortSignal[] = [];
        const shown = deferred();
        const h = await connectSession(version, {
            clientCapabilities: capabilities,
            v1ClientCapabilities: capabilities,
            onElicitation: (_request, signal) => {
                uiSignals.push(signal);
                shown.resolve();
                if (state === "accepted") return {action: "accept"};
                return new Promise(resolve => signal.addEventListener("abort", () => resolve({action: "cancel"}), {once: true}));
            },
        });
        const cancel = vi.fn(async () => ({status: "canceled"}));
        h.setCodexResponse("account/login/start", async () => loginResponse());
        h.setCodexResponse("account/login/cancel", cancel);
        const controller = new AbortController();
        try {
            const login = h.request(method, {methodId: "chat-gpt-device-code"}, controller.signal);
            void login.catch(() => {});
            await shown.promise;
            // Allow an accepted dialog's response to reach the agent.
            await new Promise<void>(resolve => setImmediate(resolve));
            controller.abort();
            await expect(login).rejects.toMatchObject({code: -32800});
            await vi.waitFor(() => {
                expect(cancel).toHaveBeenCalledWith({loginId: "login-1"});
                expect(cancelledResponse(h)).toBeGreaterThanOrEqual(0);
            });
            const dismissal = h.wireMessages.findIndex(frame => "method" in frame
                && frame.method === (state === "pending" ? "$/cancel_request" : "elicitation/complete"));
            expect(dismissal).toBeGreaterThanOrEqual(0);
            expect(dismissal).toBeLessThan(cancelledResponse(h));
            if (state === "pending") expect(uiSignals[0]?.aborted).toBe(true);
        } finally {
            h.connection.close();
        }
    });

    it.each(["chat-gpt", "chat-gpt-device-code"] as const)("cancels a late %s start without opening UI", async methodId => {
        const starting = deferred();
        const release = deferred();
        const ui = vi.fn(async () => ({action: "accept" as const}));
        const h = await connectSession(version, {clientCapabilities: capabilities, v1ClientCapabilities: capabilities, onElicitation: ui});
        const cancel = vi.fn(async () => ({status: "canceled"}));
        h.setCodexResponse("account/login/start", async () => {
            starting.resolve();
            await release.promise;
            return methodId === "chat-gpt" ? {type: "chatgpt", loginId: "login-1", authUrl: "https://example.com/auth"} : loginResponse();
        });
        h.setCodexResponse("account/login/cancel", cancel);
        const controller = new AbortController();
        try {
            const login = h.request(method, {methodId}, controller.signal);
            void login.catch(() => {});
            await starting.promise;
            controller.abort();
            await vi.waitFor(() => expect(cancelledResponse(h)).toBeGreaterThanOrEqual(0));
            release.resolve();
            await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({loginId: "login-1"}));
            expect(ui).not.toHaveBeenCalled();
            expect(open).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            h.connection.close();
        }
    });

    it("does not apply an old completion to a new login", async () => {
        const cancelRelease = deferred();
        const ui = vi.fn(async () => ({action: "accept" as const}));
        const h = await connectSession(version, {clientCapabilities: capabilities, v1ClientCapabilities: capabilities, onElicitation: ui});
        let starts = 0;
        h.setCodexResponse("account/login/start", async () => loginResponse(`login-${++starts}`));
        h.setCodexResponse("account/login/cancel", async () => { await cancelRelease.promise; return {status: "canceled"}; });
        const controller = new AbortController();
        try {
            const first = h.request(method, {methodId: "chat-gpt-device-code"}, controller.signal);
            void first.catch(() => {});
            await vi.waitFor(() => expect(ui).toHaveBeenCalledOnce());
            controller.abort();
            await vi.waitFor(() => expect(cancelledResponse(h)).toBeGreaterThanOrEqual(0));
            let finished = false;
            const second = h.request(method, {methodId: "chat-gpt-device-code"}).then(result => { finished = true; return result; });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(starts).toBe(1);
            cancelRelease.resolve();
            await vi.waitFor(() => expect(ui).toHaveBeenCalledTimes(2));
            complete(h, "login-1");
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(finished).toBe(false);
            complete(h, "login-2");
            await expect(second).resolves.toEqual({});
        } finally {
            cancelRelease.resolve();
            h.connection.close();
        }
    });

    it("drains a cancelled API-key completion before starting another login", async () => {
        const h = await connectSession(version);
        let starts = 0;
        h.setCodexResponse("account/login/start", async () => { starts++; return {type: "apiKey"}; });
        const controller = new AbortController();
        const params = {methodId: "api-key", _meta: {"api-key": {apiKey: "test-key"}}};
        try {
            const first = h.request(method, params, controller.signal);
            void first.catch(() => {});
            await vi.waitFor(() => expect(starts).toBe(1));
            controller.abort();
            await vi.waitFor(() => expect(cancelledResponse(h)).toBeGreaterThanOrEqual(0));
            const second = h.request(method, params);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(starts).toBe(1);
            complete(h, null);
            await vi.waitFor(() => expect(starts).toBe(2));
            complete(h, null);
            await expect(second).resolves.toEqual({});
        } finally {
            h.connection.close();
        }
    });

    it("cancels the owned login when its connection closes", async () => {
        const ui = vi.fn(async () => ({action: "accept" as const}));
        const h = await connectSession(version, {clientCapabilities: capabilities, v1ClientCapabilities: capabilities, onElicitation: ui});
        const cancel = vi.fn(async () => ({status: "canceled"}));
        h.setCodexResponse("account/login/start", async () => loginResponse());
        h.setCodexResponse("account/login/cancel", cancel);
        const login = h.request(method, {methodId: "chat-gpt-device-code"});
        void login.catch(() => {});
        await vi.waitFor(() => expect(ui).toHaveBeenCalledOnce());
        h.connection.close();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({loginId: "login-1"}));
    });
});
