import http from "node:http";
import type {AddressInfo} from "node:net";

type MockErrorResponse = {status: number; body: unknown};
type ResponseHandler = (request: unknown) => string | undefined | Promise<string | undefined>;

/**
 * Local stand-in for the OpenAI Responses API. Each `POST /v1/responses` from Codex gets the next queued reply;
 * a tool-call turn needs two: the call, then the answer after Codex sends the tool output.
 */
export interface MockResponsesServer {
    /** Gateway base URL to give Codex. */
    readonly baseUrl: string;
    /** Bodies of every request Codex sent, in order; shows what Codex passed back to the model. */
    readonly requests: unknown[];
    /** Requests with no queued reply (answered 400/404): Codex did something the test didn't script. */
    readonly unexpectedRequests: number;
    /** Queues replies built with `textResponse`, `execCommandResponse` or `applyPatchResponse`. */
    enqueue(...responses: string[]): void;
    /** Keeps returning the HTTP error across runtime retries, until cleared with null. */
    setErrorResponse(response: MockErrorResponse | null): void;
    /** Selects replies by request instead of arrival order, for concurrent root/child/title calls. */
    setResponseHandler(handler: ResponseHandler): void;
    close(): Promise<void>;
}

function parseBody(body: string): unknown {
    if (!body) return {};
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

export async function startMockResponsesServer(): Promise<MockResponsesServer> {
    const queue: string[] = [];
    let errorResponse: MockErrorResponse | null = null;
    let responseHandler: ResponseHandler | undefined;
    const requests: unknown[] = [];
    let unexpectedRequests = 0;
    let requestCount = 0;

    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", async () => {
            requestCount++;
            const parsed = parseBody(body);
            requests.push(parsed);
            const isResponsesCall = req.method === "POST" && (req.url ?? "").split("?")[0]!.endsWith("/responses");
            let next: string | MockErrorResponse | undefined;
            try {
                next = isResponsesCall ? errorResponse ?? (responseHandler ? await responseHandler(parsed) : queue.shift()) : undefined;
            } catch (error) {
                console.error("Mock Responses API handler failed", error);
                res.writeHead(500);
                res.end("mock: response handler failed");
                return;
            }
            if (res.destroyed) return;
            if (next === undefined) {
                unexpectedRequests++;
                res.writeHead(isResponsesCall ? 400 : 404);
                res.end(`mock: unexpected request #${requestCount}`);
                return;
            }
            if (typeof next === "string") {
                res.writeHead(200, {"content-type": "text/event-stream"});
                res.end(next);
            } else {
                res.writeHead(next.status, {"content-type": "application/json"});
                res.end(JSON.stringify(next.body));
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        get unexpectedRequests() {
            return unexpectedRequests;
        },
        enqueue: (...responses) => {
            queue.push(...responses);
        },
        setErrorResponse: response => { errorResponse = response; },
        setResponseHandler: handler => { responseHandler = handler; },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

type SseEvent = {type: string} & Record<string, unknown>;

function sse(events: SseEvent[]): string {
    return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function wrap(id: string, events: SseEvent[]): string {
    return sse([
        {type: "response.created", response: {id}},
        ...events,
        {
            type: "response.completed",
            response: {
                id,
                usage: {input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2},
            },
        },
    ]);
}

let responseCounter = 0;
function nextId(): string {
    return `resp_${++responseCounter}`;
}

/** The model answers with text, streamed as one delta per chunk. */
export function textResponse(...chunks: string[]): string {
    const itemId = `msg_${nextId()}`;
    const text = chunks.join("");
    return wrap(nextId(), [
        {type: "response.output_item.added", output_index: 0, item: {type: "message", role: "assistant", id: itemId, content: []}},
        ...chunks.map((delta) => ({type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta})),
        {type: "response.output_item.done", output_index: 0, item: {type: "message", role: "assistant", id: itemId, content: [{type: "output_text", text}]}},
    ]);
}

/** The model calls the shell tool `exec_command` with `args` (e.g. `{cmd: "echo hi"}`). */
export function execCommandResponse(callId: string, args: object): string {
    return functionCallResponse(callId, "exec_command", args);
}

export function functionCallResponse(callId: string, name: string, args: object, namespace?: string): string {
    return wrap(nextId(), [
        {type: "response.output_item.done", output_index: 0, item: {type: "function_call", id: `fc_${callId}`, call_id: callId, name,
            ...(namespace ? {namespace} : {}), arguments: JSON.stringify(args)}},
    ]);
}

/** The model calls the `apply_patch` tool with a patch in Codex's `*** Begin Patch` format. */
export function applyPatchResponse(callId: string, patch: string): string {
    return wrap(nextId(), [
        {type: "response.output_item.done", output_index: 0, item: {type: "custom_tool_call", id: `ctc_${callId}`, call_id: callId, name: "apply_patch", input: patch}},
    ]);
}
