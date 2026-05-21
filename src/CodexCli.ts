import type {ChildProcess, SpawnOptions} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";

export function runCodexCli(codexPath: string | undefined, args: Array<string>): Promise<number> {
    const child = spawnCodexCli(codexPath, args);

    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (signal) {
                process.kill(process.pid, signal);
                return;
            }
            resolve(code ?? 1);
        });
    });
}

function spawnCodexCli(codexPath: string | undefined, args: Array<string>): ChildProcess {
    const options: SpawnOptions = {
        env: process.env,
        stdio: "inherit",
    };

    if (codexPath) {
        return spawn(codexPath, args, {...options, shell: process.platform === "win32"});
    }
    const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
    return spawn(process.execPath, [bundledCodexPath, ...args], options);
}
