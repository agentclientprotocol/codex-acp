// Run with node <this file> <compiled ACP> <compiled fixture>. Both children use
// a PATH without Node; this harness itself does not supply an interpreter to them.
const {spawn, spawnSync} = require("node:child_process");
const {mkdtempSync, existsSync, rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const {once} = require("node:events");

(async () => {
    const [acp, fixture] = process.argv.slice(2);
    const dir = mkdtempSync(path.join(tmpdir(), "CodexProcessTermination-entry-"));
    try {
        const env = {...process.env, PATH: dir, CODEX_PATH: fixture,
            APP_SERVER_LOGS: "", CODEX_CONFIG: "{}", DEFAULT_AUTH_REQUEST: "",
            CODEX_PROCESS_TERMINATION_FIXTURE_DIR: dir};
        const provider = spawn(acp, [], {env, stdio: "pipe"});
        let stderr = "";
        provider.stderr.on("data", data => {stderr += data;});
        const exited = once(provider, "exit");
        const deadline = Date.now() + 10_000;
        while (!existsSync(path.join(dir, "ready"))) {
            assert(Date.now() < deadline, `ACP did not launch native fixture: ${stderr}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        provider.stdin.end();
        const [code] = await exited;
        assert.equal(code, 0, stderr);
        console.log("PASS compiled ACP entrypoint: CODEX_PATH native launch and EOF, no Node on PATH");
        for (const role of ["supervisor", "guardian", "unknown"]) {
            const result = spawnSync(acp, [`--internal-owned-process-${role}`], {
                env: {...env, CODEX_CONFIG: "invalid JSON", APP_SERVER_LOGS: path.join(dir, "forbidden-logs")},
                encoding: "utf8", timeout: 5000,
            });
            assert.equal(result.status, 1);
            assert(!existsSync(path.join(dir, "forbidden-logs")));
            assert(!result.stderr.includes("JSON"));
        }
        console.log("PASS compiled ACP helper rejection: no private fd, no config/log initialization");
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
