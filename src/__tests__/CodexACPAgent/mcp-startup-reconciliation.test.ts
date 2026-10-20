import {afterEach, describe, expect, it, vi} from "vitest";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {ServerNotification} from "../../app-server";
import type {McpServerStatus} from "../../app-server/v2";
import {connectSession, type PromptSession, sessionId} from "./v2-prompt-harness";

const versions = [1, 2] as const;
const serverName = "everything";

function server(runtimeStatus: McpServerStatus["runtimeStatus"], name = serverName): McpServerStatus {
    return {
        name,
        runtimeStatus,
        pluginId: null,
        httpOrigin: null,
        serverInfo: null,
        serverCapabilities: null,
        tools: {},
        toolsError: null,
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
    };
}

async function connect(version: 1 | 2, status: (call: number) => McpServerStatus): Promise<{
    client: PromptSession,
    statusParams: unknown[],
}> {
    const statusParams: unknown[] = [];
    const client = await connectSession(version, {
        realMcpStartup: true,
        ...(version === 2
            ? {mcpServers: [{type: "stdio", name: serverName, command: "/usr/bin/everything"} as acpV2.McpServer]}
            : {mcpServersV1: [{name: serverName, command: "/usr/bin/everything", args: [], env: []} as acp.McpServer]}),
        codexResponses: {
            "mcpServerStatus/list": async params => {
                statusParams.push(params);
                return {data: [status(statusParams.length)], nextCursor: null};
            },
        },
    });
    return {client, statusParams};
}

function emitCancelled(client: PromptSession, name = serverName): void {
    const base = {threadId: sessionId, name, error: null, failureReason: null};
    client.emit({method: "mcpServer/startupStatus/updated", params: {...base, status: "starting"}} as ServerNotification);
    client.emit({method: "mcpServer/startupStatus/updated", params: {...base, status: "cancelled"}} as ServerNotification);
}

function startupFailures(client: PromptSession): Array<acpV2.SessionUpdate> {
    return [...client.setupUpdates, ...client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])]
        .filter(update => (update as {toolCallId?: string}).toolCallId?.startsWith("mcp_startup."));
}

function deferred<T>(): {promise: Promise<T>, resolve(value: T): void} {
    let resolve!: (value: T) => void;
    return {promise: new Promise<T>(done => resolve = done), resolve};
}

describe("MCP startup cancellation reconciliation", () => {
    const clients: PromptSession[] = [];

    afterEach(() => {
        vi.useRealTimers();
        clients.splice(0).forEach(client => client.connection.close());
        vi.clearAllMocks();
    });

    it.each(versions)("ACP v%s suppresses a transient cancellation only after same-thread status is connected", async version => {
        const {client, statusParams} = await connect(version, call => server(call === 1 ? "starting" : "connected"));
        clients.push(client);
        const requestsBeforeCancellation = client.codexRequests.length;

        emitCancelled(client);

        await vi.waitFor(() => expect(statusParams).toHaveLength(2));
        expect(startupFailures(client)).toEqual([]);
        expect(statusParams).toEqual([
            expect.objectContaining({threadId: sessionId}),
            expect.objectContaining({threadId: sessionId}),
        ]);
        expect(client.codexRequests.slice(requestsBeforeCancellation).map(request => request.method))
            .toEqual(["mcpServerStatus/list", "mcpServerStatus/list"]);
    });

    it.each(versions)("ACP v%s preserves a genuine cancellation when status never connects", async version => {
        const {client, statusParams} = await connect(version, () => server("cancelled"));
        clients.push(client);
        vi.useFakeTimers();

        emitCancelled(client);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(statusParams.length).toBeGreaterThan(1);
        expect(startupFailures(client)).toHaveLength(1);
        expect(startupFailures(client)[0]).toMatchObject({status: "failed"});
        expect(statusParams.every(params => (params as {threadId?: string}).threadId === sessionId)).toBe(true);
    });

    it("publishes the cancellation at the deadline when the status request never settles", async () => {
        const status = deferred<{data: McpServerStatus[], nextCursor: string | null}>();
        const statusParams: unknown[] = [];
        const client = await connectSession(2, {
            realMcpStartup: true,
            mcpServers: [{type: "stdio", name: serverName, command: "/usr/bin/everything"} as acpV2.McpServer],
            codexResponses: {
                "mcpServerStatus/list": async params => {
                    statusParams.push(params);
                    return await status.promise;
                },
            },
        });
        clients.push(client);
        vi.useFakeTimers();

        emitCancelled(client);
        await vi.waitFor(() => expect(statusParams).toHaveLength(1));
        expect(startupFailures(client)).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(startupFailures(client)).toHaveLength(1);
        status.resolve({data: [server("connected")], nextCursor: "late-page"});
        await vi.runAllTicks();
        expect(statusParams).toHaveLength(1);
        expect(startupFailures(client)).toHaveLength(1);
    });

    it("abandons a pending status request when the session closes and ignores its late page", async () => {
        const status = deferred<{data: McpServerStatus[], nextCursor: string | null}>();
        const statusParams: unknown[] = [];
        const client = await connectSession(2, {
            realMcpStartup: true,
            mcpServers: [{type: "stdio", name: serverName, command: "/usr/bin/everything"} as acpV2.McpServer],
            codexResponses: {
                "mcpServerStatus/list": async params => {
                    statusParams.push(params);
                    return await status.promise;
                },
            },
        });
        clients.push(client);

        emitCancelled(client);
        await vi.waitFor(() => expect(statusParams).toHaveLength(1));
        await expect(client.request("session/close", {sessionId})).resolves.toBeDefined();
        expect(startupFailures(client)).toEqual([]);

        status.resolve({data: [server("connected")], nextCursor: "late-page"});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(statusParams).toHaveLength(1);
        expect(startupFailures(client)).toEqual([]);
    });

    it("uses only the latest complete multi-server snapshot", async () => {
        const names = ["alpha", "beta"];
        let calls = 0;
        const client = await connectSession(2, {
            realMcpStartup: true,
            mcpServers: names.map(name => ({type: "stdio", name, command: `/usr/bin/${name}`} as acpV2.McpServer)),
            codexResponses: {
                "mcpServerStatus/list": async () => {
                    calls += 1;
                    return calls === 1
                        ? {data: [server("connected", "alpha"), server("starting", "beta")], nextCursor: null}
                        : {data: [server("failed", "alpha"), server("connected", "beta")], nextCursor: null};
                },
            },
        });
        clients.push(client);
        vi.useFakeTimers();

        names.forEach(name => emitCancelled(client, name));
        await vi.advanceTimersByTimeAsync(5_000);

        expect(calls).toBeGreaterThan(1);
        const failures = startupFailures(client);
        expect(failures).toHaveLength(1);
        expect((failures[0] as {toolCallId?: string}).toolCallId).toContain("alpha");
    });
});
