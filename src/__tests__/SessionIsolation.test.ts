import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {prepareIsolatedHome, readSessionIsolation} from "../SessionIsolation";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });

describe("session isolation", () => {
    it("keeps default execution unchanged and rejects invalid flags", async () => {
        const env = {CODEX_HOME: "/existing/home"};
        expect(readSessionIsolation({})).toEqual({ephemeral: false, ignoreUserConfig: false});
        expect((await prepareIsolatedHome(env)).env).toBe(env);
        expect(() => readSessionIsolation({CODEX_EPHEMERAL: "maybe"})).toThrow("CODEX_EPHEMERAL");
    });

    it("copies authentication into a private home without user config or instructions", async () => {
        const original = await mkdtemp(join(tmpdir(), "acp-isolation-test-"));
        cleanup.push(() => rm(original, {recursive: true, force: true}));
        await writeFile(join(original, "auth.json"), "fixture-auth");
        await writeFile(join(original, "config.toml"), "model = 'unwanted'");
        await writeFile(join(original, "AGENTS.md"), "user instructions");
        const isolated = await prepareIsolatedHome({CODEX_HOME: original, CODEX_IGNORE_USER_CONFIG: "1"});
        cleanup.push(isolated.cleanup);
        const home = isolated.env["CODEX_HOME"]!;
        expect(await readdir(home)).toEqual(["auth.json"]);
        expect(await readFile(join(home, "auth.json"), "utf8")).toBe("fixture-auth");
        if (process.platform !== "win32") {
            expect((await stat(home)).mode & 0o777).toBe(0o700);
            expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
        }
        expect(await readFile(join(original, "config.toml"), "utf8")).toContain("unwanted");
        await isolated.cleanup();
        await expect(stat(home)).rejects.toMatchObject({code: "ENOENT"});
    });

    it("supports API key authentication when no auth file exists", async () => {
        const original = await mkdtemp(join(tmpdir(), "acp-isolation-test-"));
        cleanup.push(() => rm(original, {recursive: true, force: true}));
        const isolated = await prepareIsolatedHome({CODEX_HOME: original, CODEX_IGNORE_USER_CONFIG: "true", OPENAI_API_KEY: "fixture"});
        cleanup.push(isolated.cleanup);
        expect(isolated.env["OPENAI_API_KEY"]).toBe("fixture");
        expect(await readdir(isolated.env["CODEX_HOME"]!)).toEqual([]);
    });
    it("removes the isolated home when startup configuration is invalid", async () => {
        const original = await mkdtemp(join(tmpdir(), "acp-isolation-startup-"));
        cleanup.push(() => rm(original, {recursive: true, force: true}));
        const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
            env: {...process.env, TMPDIR: original, CODEX_HOME: original, CODEX_IGNORE_USER_CONFIG: "1", CODEX_CONFIG: "invalid-json"},
            timeout: 15_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr.toString()).toContain("Codex ACP startup failed");
        expect((await readdir(original)).filter(name => name.startsWith("codex-acp-isolated-"))).toEqual([]);
    });

});
