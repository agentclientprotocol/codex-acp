import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {describe, expect, it, vi} from "vitest";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {CodexAppServerSupervisor} from "../../app-server-recovery/CodexAppServerSupervisor";
import {describeExit} from "../../app-server-recovery/AppServerExit";
import {fakeAppServer, fakeSpawner} from "./fake-app-server";

const FAST = {closeGraceMs: 20, drainMs: 1, terminateAfterMs: 20, abandonAfterMs: 20, wedgedAfterMs: 20};

function supervisorWith(configure?: Parameters<typeof fakeSpawner>[0]) {
    const initial = fakeAppServer();
    const state = {connection: initial.connection, codexPath: undefined, stderr: ""};
    const spawner = fakeSpawner(configure);
    const supervisor = new CodexAppServerSupervisor(state, spawner.spawn, FAST);
    return {initial, state, spawner, supervisor};
}

describe("CodexAppServerSupervisor", () => {
    it("reports a SIGKILL as a crash, before the connection is disposed", async () => {
        const {initial, supervisor, state} = supervisorWith();
        state.stderr = "memory allocation failed";
        initial.rpc.answer = () => undefined;
        const pending = initial.rpc.connection.sendRequest("thread/resume", {threadId: "t"});
        const seen: Array<{signal: string | null, intentional: boolean, disposedAtCall: boolean, stderr: string}> = [];
        supervisor.onExit((exit) => seen.push({
            signal: exit.signal, intentional: exit.intentional, disposedAtCall: initial.rpc.disposed, stderr: exit.stderrTail,
        }));

        initial.child.die(null, "SIGKILL");

        await expect(pending).rejects.toThrow("Pending response rejected");
        expect(seen).toEqual([{signal: "SIGKILL", intentional: false, disposedAtCall: false, stderr: "memory allocation failed"}]);
        expect(supervisor.isAlive()).toBe(false);
        expect(supervisor.exitOf(1)?.signal).toBe("SIGKILL");
        expect(describeExit(supervisor.lastExit!)).toBe("was killed by SIGKILL, which usually means it ran out of memory");
    });

    it.skipIf(process.platform === "win32")("delivers a notification written right before the exit, then disposes", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dying-"));
        const script = path.join(dir, "codex");
        fs.writeFileSync(script, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({method: "turn/completed", params: {threadId: "t", turn: {id: "u"}}}) + "\\n", () => process.exit(1));
`);
        fs.chmodSync(script, 0o755);
        const state = {connection: startCodexConnection(script, undefined, undefined, {disposeOnExit: false}), codexPath: script, stderr: ""};
        const received: string[] = [];
        state.connection.connection.onUnhandledNotification((notification) => {
            received.push(notification.method);
        });
        let disposedAfter = -1;
        state.connection.connection.onDispose(() => {
            disposedAfter = received.length;
        });
        const supervisor = new CodexAppServerSupervisor(state);

        const exit = await supervisor.current.exited;

        expect(exit.code).toBe(1);
        expect(received).toEqual(["turn/completed"]);
        expect(disposedAfter).toBe(1);
        fs.rmSync(dir, {recursive: true, force: true});
    }, 15_000);

    it.skipIf(process.platform === "win32")("delivers a burst of output written before the exit, up to its last message", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-burst-"));
        const script = path.join(dir, "codex");
        fs.writeFileSync(script, `#!/usr/bin/env node
let out = "";
for (let i = 0; i < 10000; i++) out += JSON.stringify({method: "item/agentMessage/delta", params: {threadId: "t", delta: "x"}}) + "\\n";
out += JSON.stringify({method: "turn/completed", params: {threadId: "t", turn: {id: "u"}}}) + "\\n";
process.stdout.write(out, () => process.exit(1));
`);
        fs.chmodSync(script, 0o755);
        const state = {connection: startCodexConnection(script, undefined, undefined, {disposeOnExit: false}), codexPath: script, stderr: ""};
        let deltas = 0;
        let completedBeforeDispose = false;
        let disposed = false;
        state.connection.connection.onUnhandledNotification((notification) => {
            if (notification.method === "item/agentMessage/delta") deltas++;
            if (notification.method === "turn/completed") completedBeforeDispose = !disposed;
        });
        state.connection.connection.onDispose(() => {
            disposed = true;
        });
        const supervisor = new CodexAppServerSupervisor(state);

        await supervisor.current.exited;

        expect(deltas).toBe(10000);
        expect(completedBeforeDispose).toBe(true);
        fs.rmSync(dir, {recursive: true, force: true});
    }, 30_000);

    it.skipIf(process.platform === "win32")("waits for a backlog that takes longer to handle than the close grace time", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-backlog-"));
        const script = path.join(dir, "codex");
        fs.writeFileSync(script, `#!/usr/bin/env node
let out = "";
for (let i = 0; i < 2000; i++) out += JSON.stringify({method: "item/agentMessage/delta", params: {threadId: "t", delta: "x"}}) + "\\n";
out += JSON.stringify({method: "turn/completed", params: {threadId: "t", turn: {id: "u"}}}) + "\\n";
process.stdout.write(out, () => process.exit(1));
`);
        fs.chmodSync(script, 0o755);
        const state = {connection: startCodexConnection(script, undefined, undefined, {disposeOnExit: false}), codexPath: script, stderr: ""};
        let completed = false;
        state.connection.connection.onUnhandledNotification((notification) => {
            // About 1 ms of work per message: the backlog takes about 2 s, more than the close grace time.
            const until = performance.now() + 1;
            while (performance.now() < until) { /* busy */ }
            if (notification.method === "turn/completed") completed = true;
        });
        const supervisor = new CodexAppServerSupervisor(state, undefined, {closeGraceMs: 200});

        await supervisor.current.exited;

        expect(completed).toBe(true);
        fs.rmSync(dir, {recursive: true, force: true});
    }, 30_000);

    it("disposes after the close grace time when a grandchild keeps the pipes open", async () => {
        const {initial, supervisor} = supervisorWith();
        initial.child.emit("exit", null, "SIGKILL");
        await vi.waitFor(() => expect(initial.rpc.disposed).toBe(true));
        expect(supervisor.isAlive()).toBe(false);
        expect(initial.child.stdin.destroyed).toBe(true);
    });

    it("treats a spawn error without a pid as an exit", async () => {
        const {initial, supervisor} = supervisorWith();
        initial.child.pid = undefined;
        initial.child.emit("error", new Error("spawn codex ENOENT"));
        await vi.waitFor(() => expect(initial.rpc.disposed).toBe(true));
        expect(describeExit(supervisor.lastExit!)).toBe("could not be started (spawn codex ENOENT)");
    });

    it("stops a child that closed stdout but runs on, with SIGTERM and never SIGKILL", async () => {
        const {initial, supervisor} = supervisorWith();
        initial.child.ignoreSigterm = true;
        initial.child.stdout.end();
        initial.child.stdout.resume();
        await vi.waitFor(() => expect(supervisor.isAlive()).toBe(false), {timeout: 2000});
        expect(initial.child.signals).toEqual(["SIGTERM"]);
        expect(initial.child.stdin.destroyed).toBe(true);
        expect(supervisor.lastExit?.error).toBe("it did not stop after SIGTERM");
    });

    it("marks an exit caused by stop() as intentional and spawns a new generation", async () => {
        const {initial, supervisor, spawner, state} = supervisorWith();
        initial.child.stdin.on("finish", () => initial.child.die(0));
        const exit = await supervisor.stop();
        expect(exit.intentional).toBe(true);
        const child = supervisor.spawn();
        expect(child.generation).toBe(2);
        expect(state.connection).toBe(spawner.spawned[0]!.connection);
        expect(supervisor.isAlive()).toBe(true);
        expect(supervisor.isAlive(1)).toBe(false);
    });

    it("starts a new child with the startup arguments of the first one", async () => {
        const initial = fakeAppServer();
        const startupArgs = ["app-server", "-c", "hooks={}"];
        const state = {connection: initial.connection, codexPath: "/bin/codex", appServerStartupArgs: startupArgs, stderr: ""};
        const spawner = fakeSpawner();
        const supervisor = new CodexAppServerSupervisor(state, spawner.spawn, FAST);
        initial.child.die(null, "SIGKILL");
        await supervisor.current.exited;
        supervisor.spawn();
        expect(spawner.spawn).toHaveBeenCalledWith("/bin/codex", startupArgs);
    });

    it("does not spawn after shutdown, and does not spawn over a running child", async () => {
        const {initial, supervisor} = supervisorWith();
        expect(() => supervisor.spawn()).toThrow("still running");
        initial.child.stdin.on("finish", () => initial.child.die(0));
        supervisor.shutdown();
        expect(supervisor.isAlive()).toBe(false);
        await supervisor.current.exited;
        expect(supervisor.lastExit?.intentional).toBe(true);
        expect(() => supervisor.spawn()).toThrow("shutting down");
    });
});
