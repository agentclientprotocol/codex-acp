import {mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {once} from "node:events";
import {afterEach, describe, expect, it, vi} from "vitest";
import {startCodexConnection, terminateCodexConnection, type CodexConnection} from "../CodexJsonRpcConnection";

vi.mock("../Logger", () => ({logger: {log: vi.fn(), error: vi.fn()}}));
// Exercise the default launcher branch without launching the installed Codex.
vi.mock("node:module", async importOriginal => {
    const original = await importOriginal<typeof import("node:module")>();
    return {...original, createRequire: (...args: Parameters<typeof original.createRequire>) => {
        const require = original.createRequire(...args);
        const resolve = require.resolve;
        require.resolve = Object.assign((id: string, options?: Parameters<typeof resolve>[1]) =>
            id === "@openai/codex/bin/codex.js"
                ? fileURLToPath(new URL("./fixtures/CodexProcessTermination.cjs", import.meta.url))
                : resolve(id, options), {paths: resolve.paths});
        return require;
    }};
});

const fixture = fileURLToPath(new URL("./fixtures/CodexProcessTermination.cjs", import.meta.url));
const fixtures: {directory: string; native: CodexConnection}[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Fixture condition timed out");
        await delay(20);
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        // Zombies have exited, though kill(0) still sees them until the OS reaps them.
        if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
        }
        return true;
    } catch (error) {
        if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
    }
}

async function startFixture(defaultLauncher = false) {
    const directory = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-"));
    const native = startCodexConnection(defaultLauncher ? undefined : process.execPath,
        {...process.env, APP_SERVER_LOGS: ""}, defaultLauncher ? ["parent", directory] : [fixture, "parent", directory]);
    fixtures.push({directory, native});
    await until(() => existsSync(path.join(directory, "child.pid")) && existsSync(path.join(directory, "heartbeat")));
    const parentPid = Number(readFileSync(path.join(directory, "parent.pid"), "utf8"));
    const childPid = Number(readFileSync(path.join(directory, "child.pid"), "utf8"));
    return {directory, native, parentPid, childPid};
}

afterEach(async () => {
    for (const {directory, native} of fixtures.splice(0)) {
        // Cleanup through a fixture-specific file, never by a potentially stale PID.
        writeFileSync(path.join(directory, "cleanup"), "stop");
        await terminateCodexConnection(native).catch(() => {});
        await delay(150);
        rmSync(directory, {recursive: true, force: true});
    }
});

describe("CodexProcessTermination real owned processes", () => {
    for (const mode of ["eof", "signal"]) {
    it.skipIf(mode === "signal" && process.platform === "win32")(`preserves provider stdio and exit status through ${mode}`, async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-"));
        const native = startCodexConnection(process.execPath, {...process.env, APP_SERVER_LOGS: ""},
            [fixture, "stdio", directory]);
        fixtures.push({directory, native});
        let stdout = "";
        let stderr = "";
        native.process.stdout.on("data", data => {stdout += data;});
        native.process.stderr.on("data", data => {stderr += data;});
        await until(() => existsSync(path.join(directory, "ready")));
        const line = '{"method":"fixture/echo","params":{"text":"你好"}}\n';
        native.process.stdin.write(line);
        await until(() => stdout === line);
        const closed = once(native.process, "close");
        if (mode === "eof") native.process.stdin.end();
        else native.process.kill("SIGTERM");
        await closed;
        expect(native.process.exitCode).toBe(mode === "eof" ? 17 : 29);
        expect(stderr).toBe(mode === "eof" ? "fixture EOF\n" : "fixture SIGTERM\n");
        if (process.platform !== "win32") await terminateCodexConnection(native);
    }, 15_000);
    }

    it.skipIf(process.platform !== "win32")("does not mistake a failed Windows shim launch for a verified stopped tree", async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-"));
        const native = startCodexConnection(path.join(directory, "missing-provider.exe"));
        fixtures.push({directory, native});
        const [error] = await once(native.process, "error");
        expect(error.code).toBe("ENOENT");
        await until(() => native.process.exitCode !== null || native.process.signalCode !== null);
        const termination = terminateCodexConnection(native);
        await expect(termination).rejects.toThrow("tree state is unknown");
        expect(terminateCodexConnection(native)).toBe(termination);
    });

    it.skipIf(process.platform === "win32")("reports a provider spawn failure on stderr and exits without holding pipes open", async () => {
        const directory = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-"));
        const native = startCodexConnection(path.join(directory, "missing-provider"));
        fixtures.push({directory, native});
        let stderr = "";
        native.process.stderr.on("data", data => {stderr += data;});
        await once(native.process, "close");
        expect(native.process.exitCode).toBe(1);
        expect(stderr).toContain("ENOENT");
        await terminateCodexConnection(native);
    }, 15_000);

    it("stops the default Node launcher and its native-shaped child", async () => {
        const target = await startFixture(true);
        await terminateCodexConnection(target.native);
        await until(() => !alive(target.parentPid) && !alive(target.childPid));
    }, 20_000);

    it("stops both an ignoring parent and child, leaves another tree alive, and shares repeated closes", async () => {
        const target = await startFixture();
        const unrelated = await startFixture();
        expect(alive(target.parentPid)).toBe(true);
        expect(alive(target.childPid)).toBe(true);
        if (process.platform !== "win32") {
            process.kill(target.parentPid, "SIGTERM");
            process.kill(target.childPid, "SIGTERM");
            await delay(100);
            expect(alive(target.parentPid)).toBe(true);
            expect(alive(target.childPid)).toBe(true);
        }
        const first = terminateCodexConnection(target.native);
        expect(terminateCodexConnection(target.native)).toBe(first);
        await first;
        await until(() => !alive(target.parentPid) && !alive(target.childPid));
        expect(alive(unrelated.parentPid)).toBe(true);
        expect(alive(unrelated.childPid)).toBe(true);
        await expect(terminateCodexConnection(target.native)).resolves.toBeUndefined();
        await terminateCodexConnection(unrelated.native);
    }, 25_000);

    it.each(["exit-parent", "signal-parent"])("handles %s before close without killing a stale launcher PID", async mode => {
        const target = await startFixture();
        writeFileSync(path.join(target.directory, mode), "stop");
        await until(() => target.native.process.exitCode !== null || target.native.process.signalCode !== null);
        if (process.platform === "win32") {
            // taskkill cannot safely reconstruct a tree once its launcher has exited.
            await expect(terminateCodexConnection(target.native)).rejects.toThrow("tree state is unknown");
        } else {
            if (mode === "signal-parent") {
                expect(target.native.process.exitCode).toBeNull();
                expect(target.native.process.signalCode).toBe("SIGKILL");
            } else {
                expect(target.native.process.exitCode).toBe(23);
            }
            await terminateCodexConnection(target.native);
            await until(() => !alive(target.childPid));
        }
    }, 20_000);

    it.skipIf(process.platform === "win32")("cleans descendants even when the supervisor is killed first", async () => {
        const target = await startFixture();
        target.native.process.kill("SIGKILL");
        await until(() => target.native.process.signalCode !== null);
        await terminateCodexConnection(target.native);
        expect(alive(target.parentPid)).toBe(false);
        expect(alive(target.childPid)).toBe(false);
    }, 20_000);
});
