import {afterEach, describe, expect, it, vi} from "vitest";
import {
    execCommandResponse, functionCallResponse, startMockResponsesServer, type MockResponsesServer,
} from "./integration/mock-responses-server";

async function response(server: MockResponsesServer, body: unknown, path = "/responses") {
    const result = await fetch(`${server.baseUrl}${path}`, {method: "POST", body: JSON.stringify(body)});
    return {status: result.status, body: await result.text()};
}

function functionItem(stream: string) {
    return stream.split("\n").filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)))
        .find(event => event.type === "response.output_item.done")?.item;
}

describe("mock Responses API", () => {
    let server: MockResponsesServer | undefined;
    afterEach(async () => {
        await server?.close();
        server = undefined;
        vi.restoreAllMocks();
    });

    it("keeps FIFO replies when no request handler is installed", async () => {
        server = await startMockResponsesServer();
        server.enqueue("First queued reply", "Second queued reply");
        const replies = [await response(server, {kind: "first"})];
        server.setErrorResponse({status: 429, body: {error: "Scripted rate limit"}});
        replies.push(await response(server, {kind: "limited"}));
        server.setErrorResponse(null);
        replies.push(await response(server, {kind: "second"}));
        replies.push(await response(server, {kind: "unscripted"}));
        await expect(JSON.stringify({
            replies, requests: server.requests, unexpectedRequests: server.unexpectedRequests,
        }, null, 2)).toMatchFileSnapshot("data/mock-responses-queue.json");
    });

    it("routes concurrent requests by body even when they complete out of order", async () => {
        server = await startMockResponsesServer();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        server.setResponseHandler(async request => {
            if (request !== null && typeof request === "object" && "kind" in request && request.kind === "slow") {
                await held;
                return "Slow reply";
            }
            return "Fast reply";
        });
        let slowCompleted = false;
        const slow = response(server, {kind: "slow"}).then(result => {
            slowCompleted = true;
            return result;
        });
        void slow.catch(() => {});
        try {
            await vi.waitFor(() => expect(server!.requests).toEqual([{kind: "slow"}]));
            const fast = await response(server, {kind: "fast"});
            expect(slowCompleted).toBe(false);
            release();
            const replies = {fast, slow: await slow, requests: server.requests, unexpectedRequests: server.unexpectedRequests};
            await expect(JSON.stringify(replies, null, 2)).toMatchFileSnapshot("data/mock-responses-concurrent.json");
        } finally {
            release();
        }
    });

    it("keeps error overrides and unmatched requests ahead of request handlers", async () => {
        server = await startMockResponsesServer();
        const handler = vi.fn(() => "Selected reply");
        server.setResponseHandler(handler);
        server.setErrorResponse({status: 503, body: {error: "Scripted outage"}});
        const unavailable = await response(server, {kind: "limited"});
        const unmatched = await response(server, {kind: "wrong-path"}, "/not-responses");
        expect(handler).not.toHaveBeenCalled();
        server.setErrorResponse(null);
        const selected = await response(server, {kind: "selected"});
        expect(handler).toHaveBeenCalledExactlyOnceWith({kind: "selected"});
        await expect(JSON.stringify({
            unavailable, unmatched, selected, unexpectedRequests: server.unexpectedRequests,
        }, null, 2)).toMatchFileSnapshot("data/mock-responses-precedence.json");
    });

    it("does not fall back to queued replies when a request handler returns undefined", async () => {
        server = await startMockResponsesServer();
        server.enqueue("Not a fallback");
        server.setResponseHandler(() => undefined);
        expect(await response(server, {kind: "unscripted"})).toEqual({status: 400, body: "mock: unexpected request #1"});
        expect(server.unexpectedRequests).toBe(1);
        expect(server.requests).toEqual([{kind: "unscripted"}]);
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

        const failed = await response(server, {});
        expect(failed.body).not.toContain("Private handler diagnostic");
        expect(failed.body).not.toContain("/private/internal.ts");
        expect(log).toHaveBeenCalledWith("Mock Responses API handler failed", failure);

        server.setResponseHandler(() => "Next scripted response");
        const next = await response(server, {});
        await expect(JSON.stringify({
            status: failed.status,
            body: failed.body,
            nextStatus: next.status,
            nextBody: next.body,
        }, null, 2)).toMatchFileSnapshot("data/mock-responses-handler-failure.json");
    });

    it("scripts named and namespaced function calls without changing shell-call payloads", async () => {
        const shellArgs = {cmd: "echo hello"};
        const shell = functionItem(execCommandResponse("shell", shellArgs));
        expect(shell).toEqual(functionItem(functionCallResponse("shell", "exec_command", shellArgs)));
        const calls = [
            shell,
            functionItem(functionCallResponse("lookup", "lookup", {query: "example"})),
            functionItem(functionCallResponse("lookup-namespaced", "lookup", {query: "example"}, "helpers")),
        ];
        await expect(JSON.stringify(calls, null, 2)).toMatchFileSnapshot("data/mock-responses-function-calls.json");
    });
});
