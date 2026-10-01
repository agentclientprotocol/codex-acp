import {chmodSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {CodexAppServerClient} from "../CodexAppServerClient";
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {McpOauthCompletions} from "../mcp/McpOauthCompletions";
import {McpStartupTracker} from "../mcp/McpStartupTracker";

function startupStatus(name: string, threadId: string | null, status: "starting" | "ready" = "ready") {
    return {threadId, name, status, error: null, failureReason: null};
}

function waiterCount(tracker: McpStartupTracker): number {
    return (tracker as unknown as {waiters: unknown[]}).waiters.length;
}

function stateThreads(tracker: McpStartupTracker): Record<string, Array<string | null>> {
    const states = (tracker as unknown as {states: Map<string, Map<string | null, unknown>>}).states;
    return Object.fromEntries([...states].map(([name, byThread]) => [name, [...byThread.keys()]]));
}

function oauthWaiterCount(completions: McpOauthCompletions): number {
    const waiters = (completions as unknown as {waiters: Map<string, Set<unknown>>}).waiters;
    return [...waiters.values()].reduce((count, set) => count + set.size, 0);
}

describe("McpStartupTracker", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, {recursive: true, force: true});
        }
    });

    it.skipIf(process.platform === "win32")("rejects the MCP waits when the Codex process exits", async () => {
        // The real connection path: the process exit disposes the vscode-jsonrpc connection and fires no close event.
        const dir = mkdtempSync(path.join(tmpdir(), "codex-acp-exit-"));
        tempDirs.push(dir);
        const fakeCodex = path.join(dir, "codex");
        writeFileSync(fakeCodex, "#!/bin/sh\nexec sleep 30\n");
        chmodSync(fakeCodex, 0o755);
        const codex = startCodexConnection(fakeCodex);
        const client = new CodexAppServerClient(codex.connection);

        const startup = client.mcpStartup.await(["fs"], client.mcpStartup.version(), {threadId: "thread-id"});
        const signIn = client.mcpOauthCompletions.await("fs", "thread-id");
        codex.process.kill();

        await expect(startup).rejects.toThrow("Codex connection closed during the MCP server startup.");
        await expect(signIn).rejects.toThrow("Codex connection closed during the MCP server sign-in.");
        expect(waiterCount(client.mcpStartup)).toBe(0);
        expect(oauthWaiterCount(client.mcpOauthCompletions)).toBe(0);
        await expect(client.mcpStartup.await(["fs"], client.mcpStartup.version(), {threadId: "thread-id"}))
            .rejects.toThrow("Codex connection closed during the MCP server startup.");
    });

    it("forgets the states of a thread and keeps the global states", () => {
        const tracker = new McpStartupTracker();
        tracker.record(startupStatus("fs", "closed-thread"));
        tracker.record(startupStatus("fs", "open-thread"));
        tracker.record(startupStatus("only-closed", "closed-thread"));
        tracker.record(startupStatus("global", null));

        tracker.forgetThread("closed-thread");

        expect(stateThreads(tracker)).toEqual({fs: ["open-thread"], global: [null]});
    });

    it("removes an aborted wait", async () => {
        const tracker = new McpStartupTracker();
        const abort = new AbortController();
        const startup = tracker.await(["fs"], tracker.version(), {threadId: "thread-id", signal: abort.signal});
        expect(waiterCount(tracker)).toBe(1);

        abort.abort(new Error("closed"));

        await expect(startup).rejects.toThrow("closed");
        expect(waiterCount(tracker)).toBe(0);
    });
});

describe("McpOauthCompletions", () => {
    it("completes every sign-in that waits for the server", async () => {
        const completions = new McpOauthCompletions();
        const first = completions.await("linear", "thread-id");
        const second = completions.await("linear", "thread-id");
        const other = completions.await("github", "thread-id");

        completions.complete({name: "linear", threadId: "thread-id", success: true});

        await expect(first).resolves.toMatchObject({name: "linear", success: true});
        await expect(second).resolves.toMatchObject({name: "linear", success: true});
        expect(oauthWaiterCount(completions)).toBe(1);
        completions.complete({name: "github", threadId: "thread-id", success: false});
        await expect(other).resolves.toMatchObject({name: "github", success: false});
        expect(oauthWaiterCount(completions)).toBe(0);
    });

    it("ignores the completion of another thread", async () => {
        const completions = new McpOauthCompletions();
        let completed = false;
        void completions.await("linear", "thread-id").then(() => { completed = true; });

        completions.complete({name: "linear", threadId: "other-thread", success: true});
        await Promise.resolve();

        expect(completed).toBe(false);
        expect(oauthWaiterCount(completions)).toBe(1);
    });

    it("removes an aborted wait", async () => {
        const completions = new McpOauthCompletions();
        const abort = new AbortController();
        const signIn = completions.await("linear", "thread-id", abort.signal);

        abort.abort(new Error("cancelled"));

        await expect(signIn).rejects.toThrow("cancelled");
        expect(oauthWaiterCount(completions)).toBe(0);
    });
});
