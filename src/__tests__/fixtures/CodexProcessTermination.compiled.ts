// Compile this entrypoint with `bun build --compile` and run with:
// <binary> <absolute-node-path> <absolute-CodexProcessTermination.cjs-path>
// Keep build output outside dist. Linux tests need an init that reaps orphans.
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {once} from "node:events";
import {runInternalProcessHelper} from "../../CodexProcessHelpers";
await runInternalProcessHelper();
const {startCodexConnection, terminateCodexConnection} = await import("../../CodexJsonRpcConnection");

const [node, fixture] = process.argv.slice(2);
assert(node && fixture, "Pass Node and fixture paths");
const isBun = Boolean(process.versions["bun"]);
if (isBun) assert.notEqual(process.execPath, node);
const directory = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-compiled-"));
const env = {...process.env, PATH: directory, APP_SERVER_LOGS: ""};
const providerArgs = (role: string, dir: string) => fixture === "native" ? [role, dir] : [fixture, role, dir];
const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
        assert(Date.now() < deadline, "Fixture wait timed out");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};
try {
    for (const mode of ["kill", "parent-first"]) {
        const caseDir = path.join(directory, mode);
        mkdirSync(caseDir);
        const native = startCodexConnection(node, env, providerArgs("parent", caseDir));
        native.process.stderr.on("data", data => process.stderr.write(data));
        try {
            await until(() => existsSync(path.join(caseDir, "heartbeat")));
            const pids = ["parent.pid", "child.pid"].map(name => Number(readFileSync(path.join(caseDir, name), "utf8")));
            if (mode === "parent-first") {
                const exited = once(native.process, "exit");
                writeFileSync(path.join(caseDir, "exit-parent"), "exit");
                await exited;
                assert.equal(native.process.exitCode, 23);
            }
            await terminateCodexConnection(native);
            for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: "ESRCH"});
            await terminateCodexConnection(native);
            console.log(`PASS compiled ${mode}: parent and child gone`);
        } finally {
            writeFileSync(path.join(caseDir, "cleanup"), "stop");
            await terminateCodexConnection(native).catch(() => {});
        }
    }
    const native = startCodexConnection(node, env, providerArgs("stdio", directory));
    let stdout = "";
    let stderr = "";
    native.process.stdout.on("data", data => {stdout += data;});
    native.process.stderr.on("data", data => {stderr += data;});
    await until(() => existsSync(path.join(directory, "ready")));
    const line = '{"method":"fixture/echo","params":{"text":"你好"}}\n';
    native.process.stdin.write(line);
    await until(() => stdout === line);
    const closed = once(native.process, "close");
    native.process.stdin.end();
    await closed;
    assert.equal(native.process.exitCode, 17);
    assert.equal(stderr, "fixture EOF\n");
    await terminateCodexConnection(native);
    console.log("PASS compiled EOF: exact stdout/stderr and exit code 17");

    const stalledDir = path.join(directory, "stalled");
    mkdirSync(stalledDir);
    const stalled = startCodexConnection(node, env, providerArgs("parent", stalledDir));
    await until(() => existsSync(path.join(stalledDir, "heartbeat")));
    const group = stalled.process.pid!;
    process.kill(-group, "SIGSTOP"); // Hold this live owned group so it cannot service the control pipe.
    try {
        await assert.rejects(terminateCodexConnection(stalled), /timed out; tree state is unknown/);
        assert.equal(stalled.process.exitCode, null);
        assert.equal(stalled.process.signalCode, null);
    } finally {
        process.kill(-group, "SIGCONT"); // The stopped group still pins its identity.
    }
    await until(() => {
        try {process.kill(-group, 0); return false;}
        catch (error) {if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error;}
    });
    console.log("PASS compiled timeout: stopped group rejected after deadline, then reaped after resume");


} finally {
    rmSync(directory, {recursive: true, force: true});
}
