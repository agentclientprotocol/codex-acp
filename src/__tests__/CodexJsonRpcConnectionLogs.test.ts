import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {afterEach, describe, expect, it, vi} from "vitest";
import {attachLogs} from "../CodexJsonRpcConnection";
import {logger} from "../Logger";

function fakeProcess(attach: typeof attachLogs = attachLogs) {
    const proc = new EventEmitter() as EventEmitter & {stdin: PassThrough; stdout: PassThrough; stderr: PassThrough};
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    attach(proc as unknown as ChildProcessWithoutNullStreams);
    return proc;
}

/** A chunk that records whether the adapter turned it into a string. */
function chunk(text: string): Buffer & {toString: ReturnType<typeof vi.fn>} {
    const buffer = Buffer.from(text);
    const toString = vi.fn(buffer.toString.bind(buffer));
    return Object.assign(buffer, {toString});
}

describe("attachLogs", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("does not turn app-server traffic into strings when logging is off", () => {
        vi.spyOn(logger, "enabled", "get").mockReturnValue(false);
        const log = vi.spyOn(logger, "log").mockImplementation(() => {});
        const proc = fakeProcess();
        const input = chunk("{\"id\":1}\n");
        const output = chunk("{\"id\":1,\"result\":{}}\n");
        const error = chunk("warning\n");
        const written: string[] = [];
        proc.stdin.on("data", (data: Buffer) => written.push(Buffer.from(data).toString("utf8")));

        proc.stdin.write(input);
        proc.stdout.emit("data", output);
        proc.stderr.emit("data", error);

        expect(input.toString).not.toHaveBeenCalled();
        expect(output.toString).not.toHaveBeenCalled();
        expect(error.toString).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(written).toEqual(["{\"id\":1}\n"]);
    });

    it("logs the same lines as before when logging is on", () => {
        vi.spyOn(logger, "enabled", "get").mockReturnValue(true);
        const log = vi.spyOn(logger, "log").mockImplementation(() => {});
        const proc = fakeProcess();

        proc.stdin.write("{\"id\":1}\n");
        proc.stdout.emit("data", Buffer.from("{\"id\":1,\"result\":{}}\n"));
        proc.stderr.emit("data", Buffer.from("warning\n"));
        proc.emit("exit", 0);

        expect(log.mock.calls).toEqual([
            ["[IN] {\"id\":1}\n"],
            ["[OUT] {\"id\":1,\"result\":{}}\n"],
            ["[ERR] warning\n"],
            ["[EXIT] code: 0"],
        ]);
    });

    it("writes the traffic to the log file when APP_SERVER_LOGS is set", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "app-server-logs-"));
        try {
            vi.stubEnv("APP_SERVER_LOGS", directory);
            vi.resetModules();
            const fresh = await import("../CodexJsonRpcConnection");
            const freshLogger = (await import("../Logger")).logger;
            expect(freshLogger.enabled).toBe(true);
            const proc = fakeProcess(fresh.attachLogs);

            proc.stdin.write("{\"id\":1}\n");
            proc.stdout.emit("data", Buffer.from("{\"id\":1,\"result\":{}}\n"));
            proc.stderr.emit("data", Buffer.from("warning\n"));
            proc.emit("exit", 0);

            const lines = fs.readFileSync(path.join(directory, "app-server.log"), "utf8").split("\n")
                .map(line => line.replace(/^\S+ \S+ /, "").replace(/ \{"pid":\d+\}$/, ""));
            expect(lines.slice(1)).toEqual(["[IN] {\"id\":1}", "", "[OUT] {\"id\":1,\"result\":{}}", "", "[ERR] warning", "", "[EXIT] code: 0", ""]);
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    it("is off without APP_SERVER_LOGS", async () => {
        vi.stubEnv("APP_SERVER_LOGS", "");
        vi.resetModules();

        expect((await import("../Logger")).logger.enabled).toBe(false);
    });
});
