import {afterEach, describe, expect, it, vi} from "vitest";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import {THREAD_TOOLS} from "../../thread-tools-mcp/catalog";
import {CodexThreadToolExecutor} from "../../thread-tools-mcp/executor";
import {toolResult} from "../../thread-tools-mcp/output";
import {CodexThreadToolsMcpServer} from "../../thread-tools-mcp/server";

describe("Codex thread tools MCP server", () => {
    let server: CodexThreadToolsMcpServer | null = null;
    let client: Client | null = null;

    afterEach(async () => {
        await client?.close();
        await server?.close();
    });

    it("serves the thread tool catalog over authenticated HTTP", async () => {
        const threadList = vi.fn().mockResolvedValue({data: [], nextCursor: null});
        server = new CodexThreadToolsMcpServer({threadList} as unknown as CodexAppServerClient);
        const config = await server.config();
        const url = new URL(config["url"] as string);
        const authorization = (config["http_headers"] as {Authorization: string}).Authorization;

        await expect(fetch(url, {method: "POST"})).resolves.toMatchObject({status: 401});

        client = new Client({name: "thread-tools-test", version: "1.0.0"});
        const transport = new StreamableHTTPClientTransport(url, {
            requestInit: {headers: {Authorization: authorization}},
        });
        await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

        const result = await client.listTools();
        expect(result.tools.map(tool => tool.name)).toEqual(THREAD_TOOLS.map(tool => tool.name));

        const call = await client.callTool({name: "list_threads", arguments: {limit: 15}, _meta: toolMetadata()});
        expect(call.isError).not.toBe(true);
        expect(threadList).toHaveBeenCalledWith(expect.objectContaining({limit: 15}));
    });

    it("closes cleanly while the HTTP server starts", async () => {
        server = new CodexThreadToolsMcpServer({} as CodexAppServerClient);

        const [config] = await Promise.all([server.config(), server.close()]);
        expect(config["url"]).not.toContain("null");
    });

    it("reads only the requested turn page", async () => {
        const threadRead = vi.fn().mockResolvedValue({thread: thread({historyMode: "paginated"})});
        const sendRequest = vi.fn().mockResolvedValue({data: [], nextCursor: "next", backwardsCursor: null});
        const executor = createExecutor({threadRead, connection: {sendRequest}});

        const result = await executor.execute("read_thread", {threadId: "target", turnLimit: 2}, toolMetadata()) as {
            page: {nextCursor: string | null};
        };

        expect(threadRead).toHaveBeenCalledWith({threadId: "target", includeTurns: false});
        expect(sendRequest).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({
            threadId: "target",
            limit: 2,
            itemsView: "full",
        }));
        expect(result.page.nextCursor).toBe("next");
    });

    it("falls back to legacy history when turn pagination is unavailable", async () => {
        const legacyTurn = turn("legacy", "completed");
        const threadRead = vi.fn().mockImplementation(async ({includeTurns}: {includeTurns: boolean}) => ({
            thread: thread({turns: includeTurns ? [legacyTurn] : []}),
        }));
        const sendRequest = vi.fn().mockRejectedValue(new Error("thread/turns/list is unavailable before first user message"));
        const executor = createExecutor({threadRead, connection: {sendRequest}});

        const result = await executor.execute(
            "read_thread",
            {threadId: "target", turnLimit: 1},
            toolMetadata(),
        ) as {page: {hasMore: boolean}, turns: Array<{id: string}>};

        expect(result.turns).toEqual([expect.objectContaining({id: "legacy"})]);
        expect(result.page.hasMore).toBe(false);
        expect(threadRead).toHaveBeenCalledWith({threadId: "target", includeTurns: true});
    });

    it("rejects an invalid optional boolean", async () => {
        const executor = createExecutor({});

        await expect(executor.execute(
            "read_thread",
            {threadId: "target", includeOutputs: "true"},
            toolMetadata(),
        )).rejects.toThrow("includeOutputs must be a boolean");
    });

    it("sends delegated prompts as tool output", async () => {
        const threadRead = vi.fn().mockResolvedValue({thread: thread({id: "target", historyMode: "paginated"})});
        const sendRequest = vi.fn()
            .mockResolvedValueOnce(resumeResponse())
            .mockResolvedValueOnce({turn: {id: "delegated-turn"}});
        const executor = createExecutor({threadRead, connection: {sendRequest}});

        await executor.execute(
            "send_message_to_thread",
            {threadId: "target", prompt: "continue"},
            {threadId: "source", turnId: "source-turn"},
        );

        expect(sendRequest).toHaveBeenNthCalledWith(1, "thread/resume", expect.objectContaining({
            threadId: "target",
            excludeTurns: true,
        }));
        expect(sendRequest).toHaveBeenNthCalledWith(2, "turn/start", expect.objectContaining({
            threadId: "target",
            input: [],
            toolOutput: {
                name: "send_message_to_thread",
                namespace: "codex_tui",
                output: "<codex_delegation>\n  <source_thread_id>source</source_thread_id>\n  <input>continue</input>\n</codex_delegation>",
            },
        }));
    });

    it("forks a running task before its active turn", async () => {
        const threadRead = vi.fn().mockResolvedValue({thread: thread({id: "target", status: {type: "active", activeFlags: []}, historyMode: "paginated"})});
        const sendRequest = vi.fn()
            .mockResolvedValueOnce({
                data: [turn("current", "inProgress"), turn("completed", "completed")],
                nextCursor: null,
                backwardsCursor: null,
            })
            .mockResolvedValueOnce({thread: thread({id: "fork"})});
        const executor = createExecutor({threadRead, connection: {sendRequest}});

        await executor.execute("fork_thread", {threadId: "target"}, {threadId: "source", turnId: "source-turn"});

        expect(sendRequest).toHaveBeenNthCalledWith(1, "thread/turns/list", expect.objectContaining({limit: 1}));
        expect(sendRequest).toHaveBeenNthCalledWith(2, "thread/fork", expect.objectContaining({
            threadId: "target",
            beforeTurnId: "current",
            excludeTurns: true,
        }));
    });

    it("inherits source settings when it creates a task", async () => {
        const threadRead = vi.fn().mockResolvedValue({thread: thread({historyMode: "paginated"})});
        const threadSetName = vi.fn().mockResolvedValue({});
        const sendRequest = vi.fn()
            .mockResolvedValueOnce(resumeResponse())
            .mockResolvedValueOnce({thread: thread({id: "created"})})
            .mockResolvedValueOnce({turn: {id: "created-turn"}});
        const executor = createExecutor({threadRead, threadSetName, connection: {sendRequest}});

        await executor.execute(
            "create_thread",
            {prompt: "work", title: "Child"},
            {threadId: "source", turnId: "source-turn"},
        );

        expect(sendRequest).toHaveBeenNthCalledWith(2, "thread/start", expect.objectContaining({
            cwd: "/workspace",
            model: "gpt-test",
            modelProvider: "openai",
            serviceTier: "priority",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: "workspace-write",
            runtimeWorkspaceRoots: ["/workspace"],
            config: {url: "http://127.0.0.1/mcp"},
        }));
        expect(threadSetName).toHaveBeenCalledWith({threadId: "created", name: "Child"});
    });

    it("wakes when the latest task turn has completed", async () => {
        const threadRead = vi.fn().mockResolvedValue({
            thread: thread({id: "target", status: {type: "idle"}, historyMode: "paginated"}),
        });
        const sendRequest = vi.fn()
            .mockResolvedValueOnce({
                data: [turn("completed", "completed")],
                nextCursor: null,
                backwardsCursor: null,
            })
            .mockRejectedValueOnce(new Error("thread/items/list is not supported yet"));
        const executor = createExecutor({threadRead, connection: {sendRequest}});

        const result = await executor.execute(
            "wait_threads",
            {targets: [{threadId: "target"}], timeoutMs: 0},
            {threadId: "source", turnId: "source-turn"},
        ) as {timedOut: boolean, wake: {threadId: string, reason: string, turnId: string}};

        expect(result).toMatchObject({
            timedOut: false,
            wake: {threadId: "target", reason: "turnCompleted", turnId: "completed"},
        });
        expect(sendRequest).toHaveBeenNthCalledWith(1, "thread/turns/list", expect.objectContaining({
            threadId: "target",
            limit: 1,
            itemsView: "summary",
        }));
        expect(sendRequest).toHaveBeenNthCalledWith(2, "thread/items/list", expect.objectContaining({
            threadId: "target",
            turnId: "completed",
            limit: 20,
        }));
    });

    it("rejects a delegated prompt that grows beyond the wrapped limit", async () => {
        const executor = createExecutor({});

        await expect(executor.execute(
            "create_thread",
            {prompt: "&".repeat(300)},
            toolMetadata(),
        )).rejects.toThrow("prompt exceeded the maximum context budget");
    });

    it("cancels an in-flight wait", async () => {
        const threadRead = vi.fn().mockReturnValue(new Promise(() => {}));
        const executor = createExecutor({threadRead});
        const controller = new AbortController();
        const execution = executor.execute(
            "wait_threads",
            {targets: [{threadId: "target"}]},
            toolMetadata(),
            controller.signal,
        );

        await Promise.resolve();
        controller.abort(new Error("cancelled"));

        await expect(execution).rejects.toThrow("cancelled");
    });

    it("keeps the last poll when a wait reaches its deadline", async () => {
        const threadRead = vi.fn().mockImplementation(async () => {
            await delay(10);
            return {thread: thread({id: "target", status: {type: "active", activeFlags: []}})};
        });
        const sendRequest = vi.fn().mockImplementation(async (method: string) => {
            await delay(10);
            return method === "thread/turns/list"
                ? {data: [turn("active", "inProgress")], nextCursor: null, backwardsCursor: null}
                : {data: [], nextCursor: null, backwardsCursor: null};
        });
        const onThreadStatus = vi.fn().mockReturnValue(() => {});
        const executor = createExecutor({threadRead, onThreadStatus, connection: {sendRequest}});

        const result = await executor.execute(
            "wait_threads",
            {targets: [{threadId: "target"}], timeoutMs: 100},
            toolMetadata(),
        ) as {timedOut: boolean, polls: unknown[], errors?: unknown[]};

        expect(result.timedOut).toBe(true);
        expect(result.polls).toHaveLength(1);
        expect(result.errors).toBeUndefined();
    });

    it("ignores malformed nested metadata when direct metadata is valid", async () => {
        const threadList = vi.fn().mockResolvedValue({data: [], nextCursor: null});
        const executor = createExecutor({threadList});

        await expect(executor.execute(
            "list_threads",
            {},
            {threadId: "source", "x-codex-turn-metadata": []},
        )).resolves.toBeDefined();
    });

    it("reduces an oversized thread list instead of failing", () => {
        const threads = Array.from({length: 10}, (_, index) => ({
            id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
            kind: "codex",
            title: "title".repeat(20),
            summary: "summary".repeat(50),
            status: "idle",
            cwd: "/workspace/project",
            updatedAt: 1,
        }));

        const text = toolResult({schemaVersion: 4, threads}).content.at(0)!.text;

        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(999);
        expect((JSON.parse(text) as {threads: unknown[]}).threads.length).toBeLessThan(threads.length);
    });
});

function createExecutor(client: object): CodexThreadToolExecutor {
    return new CodexThreadToolExecutor(client as CodexAppServerClient, async () => ({url: "http://127.0.0.1/mcp"}));
}

function toolMetadata(): {threadId: string, turnId: string} {
    return {threadId: "source", turnId: "current"};
}

function thread(overrides: Record<string, unknown> = {}): object {
    return {
        id: "source",
        preview: "preview",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        status: {type: "idle"},
        cwd: "/workspace",
        name: "Source",
        turns: [],
        projectId: null,
        historyMode: "legacy",
        ...overrides,
    };
}

function turn(id: string, status: "inProgress" | "completed"): object {
    return {
        id,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [],
    };
}

function resumeResponse(): object {
    return {
        thread: thread(),
        model: "gpt-test",
        modelProvider: "openai",
        serviceTier: "priority",
        cwd: "/workspace",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
            type: "workspaceWrite",
            writableRoots: ["/workspace"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        },
        runtimeWorkspaceRoots: ["/workspace"],
        activePermissionProfile: null,
        reasoningEffort: "medium",
    };
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
}
