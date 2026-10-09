import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {afterEach, describe, expect, it, vi} from "vitest";
import {startCodexConnection, terminateCodexConnection} from "../CodexJsonRpcConnection";

const mocks = vi.hoisted(() => ({spawn: vi.fn(), spawnSync: vi.fn(), dispose: vi.fn()}));
vi.mock("node:child_process", () => ({spawn: mocks.spawn, spawnSync: mocks.spawnSync}));
vi.mock("cross-spawn", () => ({default: mocks.spawn}));
vi.mock("vscode-jsonrpc/node", () => ({
    createMessageConnection: () => ({listen() {}, dispose: mocks.dispose}),
}));
vi.mock("../StdUtils", () => ({createJSONRPCReader() {}, createJSONRPCWriter() {}}));
vi.mock("../Logger", () => ({logger: {log: vi.fn()}}));

function child(pid: number | undefined = 987654) {
    return Object.assign(new EventEmitter(), {
        pid: pid as number | undefined, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        stdio: [null, null, null, Object.assign(new PassThrough(), {unref: vi.fn()})], kill: vi.fn(),
    });
}
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function usePlatform(value: string) {
    Object.defineProperty(process, "platform", {...platform, value});
}
afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.spawn.mockReset();
    mocks.dispose.mockReset();
});

describe("CodexProcessTermination failure boundaries", () => {
    it.each(["linux", "win32"])("does not signal or wait for a nonexistent PID on %s", async platform => {
        usePlatform(platform);
        const provider = child();
        provider.pid = undefined;
        mocks.spawn.mockReturnValue(provider);
        const native = startCodexConnection("synthetic-provider");
        await terminateCodexConnection(native);
        await terminateCodexConnection(native);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(provider.kill).not.toHaveBeenCalled();
        expect(mocks.dispose).toHaveBeenCalledTimes(1);
    });

    it("rejects unowned processes without signalling a PID or shared group", async () => {
        const provider = child();
        const kill = vi.spyOn(process, "kill");
        await expect(terminateCodexConnection({
            process: provider as unknown as ChildProcessWithoutNullStreams,
            connection: {dispose: mocks.dispose} as any,
        })).rejects.toThrow("unowned");
        expect(kill).not.toHaveBeenCalled();
        expect(provider.kill).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each(["SIGTERM", "SIGKILL"] as const)("recognizes already signalled Windows exit (%s) without reusing its PID", async signal => {
        usePlatform("win32");
        const provider = child();
        mocks.spawn.mockReturnValue(provider);
        const native = startCodexConnection("synthetic-provider");
        provider.signalCode = signal;
        await expect(terminateCodexConnection(native)).rejects.toThrow("tree state is unknown");
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });

    it("does not treat launcher exit as successful taskkill and never retries the old PID", async () => {
        usePlatform("win32");
        const provider = child();
        const killer = child(987655);
        mocks.spawn.mockReturnValueOnce(provider).mockReturnValueOnce(killer);
        const native = startCodexConnection("synthetic-provider");
        const termination = terminateCodexConnection(native);
        const failure = expect(termination).rejects.toThrow("tree termination failed");
        provider.signalCode = "SIGKILL";
        killer.emit("exit", 1);
        await failure;
        expect(terminateCodexConnection(native)).toBe(termination);
        expect(mocks.spawn).toHaveBeenCalledTimes(2);
        expect(mocks.spawn.mock.calls[1]).toEqual([
            "taskkill", ["/PID", "987654", "/T", "/F"], {windowsHide: true, stdio: "ignore"},
        ]);
    });

    it("rejects a taskkill timeout and caches the failure", async () => {
        vi.useFakeTimers();
        usePlatform("win32");
        const provider = child();
        const killer = child(987655);
        mocks.spawn.mockReturnValueOnce(provider).mockReturnValueOnce(killer);
        const native = startCodexConnection("synthetic-provider");
        const termination = terminateCodexConnection(native);
        const failure = expect(termination).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(5_000);
        await failure;
        expect(killer.kill).toHaveBeenCalledTimes(1);
        expect(terminateCodexConnection(native)).toBe(termination);
        expect(mocks.spawn).toHaveBeenCalledTimes(2);
    });

    it("does not report stopped when taskkill succeeded but no child exit was observed", async () => {
        vi.useFakeTimers();
        usePlatform("win32");
        mocks.spawn.mockReturnValueOnce(child()).mockReturnValueOnce(child(987655));
        const native = startCodexConnection("synthetic-provider");
        const termination = terminateCodexConnection(native);
        const failure = expect(termination).rejects.toThrow("timed out");
        mocks.spawn.mock.results[1]!.value.emit("exit", 0);
        await vi.advanceTimersByTimeAsync(5_000);
        await failure;
    });

    it.each([undefined, "synthetic-provider"])("owns an isolated POSIX group for launcher %s and only probes its PGID", async command => {
        usePlatform("linux");
        const provider = child();
        mocks.spawn.mockReturnValue(provider);
        const kill = vi.spyOn(process, "kill").mockImplementation(() => {
            throw Object.assign(new Error("gone"), {code: "ESRCH"});
        });
        const native = startCodexConnection(command);
        expect(mocks.spawn.mock.calls[0]![2]).toMatchObject({detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"]});
        expect((provider.stdio[3] as PassThrough & {unref: ReturnType<typeof vi.fn>}).unref).toHaveBeenCalledOnce();
        const args = mocks.spawn.mock.calls[0]![1] as string[];
        if (command === undefined) expect(args.some(arg => /codex[/\\]bin[/\\]codex.js$/.test(arg))).toBe(true);
        else expect(args).toContain(command);
        provider.signalCode = "SIGKILL";
        await terminateCodexConnection(native);
        expect(kill).toHaveBeenCalledExactlyOnceWith(-987654, 0);
        expect(provider.kill).not.toHaveBeenCalled();
    });

    it("rejects when a POSIX group remains after its leader exits; no destructive PID retry", async () => {
        vi.useFakeTimers();
        usePlatform("linux");
        const provider = child();
        mocks.spawn.mockReturnValue(provider);
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        const native = startCodexConnection("synthetic-provider");
        provider.exitCode = 0;
        const termination = terminateCodexConnection(native);
        const failure = expect(termination).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(5_000);
        await failure;
        expect(kill.mock.calls.every(([pid, signal]) => pid === -987654 && signal === 0)).toBe(true);
        expect(terminateCodexConnection(native)).toBe(termination);
        expect(provider.listenerCount("exit")).toBe(2); // only the permanent logging/disposal listeners
    });
});
