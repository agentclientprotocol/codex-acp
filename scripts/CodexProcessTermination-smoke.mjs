#!/usr/bin/env node
// Linux/macOS: node scripts/CodexProcessTermination-smoke.mjs
// Offline: append --compile-executable-path=/absolute/path/to/bun
// Containers must use --init so killed orphan group members are reaped.
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

if (process.platform === "win32") throw new Error("Run this POSIX process-group smoke test on Linux/macOS (containers: --init)");
const options = process.argv.slice(2);
if (options.length > 1 || options.some(value => !value.startsWith("--compile-executable-path="))) {
    throw new Error("Usage: node scripts/CodexProcessTermination-smoke.mjs [--compile-executable-path=/absolute/path/to/bun]");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-smoke-"));
const noNode = path.join(work, "empty-path");
mkdirSync(noNode);
// Keep fixture runs isolated from the user's ACP configuration and log settings.
const env = {...process.env, APP_SERVER_LOGS: "", CODEX_CONFIG: "{}", DEFAULT_AUTH_REQUEST: ""};
function run(command, args, runEnv = env) {
    const result = spawnSync(command, args, {
        cwd: root, env: runEnv, stdio: "inherit", timeout: 60_000,
        killSignal: "SIGKILL", windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} failed: status=${result.status}, signal=${result.signal}`);
}
function compile(source, name) {
    const output = path.join(work, name);
    // Native host target avoids cross-runtime downloads; an explicit cached Bun
    // executable may be supplied for fully offline reproduction.
    run("bun", ["build", "--minify", "--compile", ...options, source, "--outfile", output]);
    return output;
}
try {
    const fixture = compile("src/__tests__/fixtures/CodexProcessTermination.cjs", "native-fixture");
    const transport = compile("src/__tests__/fixtures/CodexProcessTermination.compiled.ts", "transport-smoke");
    const acp = compile("src/index.ts", "codex-acp");
    run(transport, [fixture, "native"], {...env, PATH: noNode});
    run(process.execPath, ["src/__tests__/fixtures/CodexProcessTermination.entrypoint.cjs", acp, fixture],
        {...env, PATH: noNode});
    console.log("PASS compiled POSIX smoke: no Node on child PATH; group termination, EOF, timeout and ACP entrypoint verified");
} finally {
    rmSync(work, {recursive: true, force: true});
}
