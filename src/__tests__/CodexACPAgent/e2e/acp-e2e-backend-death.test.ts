import {execSync} from "node:child_process";
import {afterEach, expect, it} from "vitest";
import {createUnauthenticatedFixture, describeE2E, type SpawnedAgentFixture} from "./acp-e2e-test-utils";

// The process walk uses `ps`, so the spec is POSIX-only; the behaviour under
// test is platform-independent (the exit hook listens for both child exit and
// stdout EOF).
describeE2E("E2E backend death", () => {
    let fixture: SpawnedAgentFixture;

    afterEach(async () => {
        await fixture?.dispose();
    });

    it.skipIf(process.platform === "win32")(
        "exits promptly when the codex backend dies",
        async () => {
            fixture = await createUnauthenticatedFixture();
            const agentPid = fixture.agentPid;
            expect(agentPid).toBeDefined();

            const backend = descendantsOf(agentPid as number).find(
                (p) => /app-server/.test(p.command) && !/codex\.js/.test(p.command),
            );
            expect(backend, "codex app-server process not found under the agent").toBeDefined();

            process.kill((backend as ProcessRow).pid, "SIGKILL");

            const exited = await fixture.waitForAgentExit(5_000);
            expect(exited, "agent did not exit within 5s of its backend dying").toBe(true);
        },
    );
});

interface ProcessRow {
    pid: number;
    ppid: number;
    command: string;
}

function descendantsOf(rootPid: number): ProcessRow[] {
    const out = execSync("ps -axo pid=,ppid=,command=", {encoding: "utf8"});
    const rows = out
        .trim()
        .split("\n")
        .map((line): ProcessRow | null => {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
            return m ? {pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? ""} : null;
        })
        .filter((row): row is ProcessRow => row !== null);
    const result: ProcessRow[] = [];
    const walk = (parent: number): void => {
        for (const row of rows) {
            if (row.ppid === parent) {
                result.push(row);
                walk(row.pid);
            }
        }
    };
    walk(rootPid);
    return result;
}
