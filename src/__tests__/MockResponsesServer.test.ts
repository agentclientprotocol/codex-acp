import {afterEach, describe, expect, it, vi} from "vitest";
import {startMockResponsesServer, type MockResponsesServer} from "./integration/mock-responses-server";

describe("mock Responses API handler failures", () => {
    let server: MockResponsesServer | undefined;
    afterEach(async () => {
        await server?.close();
        server = undefined;
        vi.restoreAllMocks();
    });

    it.each([false, true])("keeps diagnostics out of HTTP responses (async: %s)", async asynchronous => {
        const error = new Error("Private handler diagnostic");
        error.stack = "Error: Private handler diagnostic\n    at handler (/private/internal.ts:42:1)";
        const failure = asynchronous ? error.stack : error;
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        server = await startMockResponsesServer();
        server.setResponseHandler(asynchronous
            ? async () => { throw failure; }
            : () => { throw failure; });

        const response = await fetch(`${server.baseUrl}/responses`, {method: "POST", body: "{}"});
        const body = await response.text();
        expect(body).not.toContain("Private handler diagnostic");
        expect(body).not.toContain("/private/internal.ts");
        expect(log).toHaveBeenCalledWith("Mock Responses API handler failed", failure);

        server.setResponseHandler(() => "Next scripted response");
        const next = await fetch(`${server.baseUrl}/responses`, {method: "POST", body: "{}"});
        await expect(JSON.stringify({
            status: response.status,
            body,
            nextStatus: next.status,
            nextBody: await next.text(),
        }, null, 2)).toMatchFileSnapshot("data/mock-responses-handler-failure.json");
    });
});
