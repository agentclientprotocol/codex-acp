import type {ChildProcess, SpawnOptions} from "node:child_process";
import {spawn} from "node:child_process";

export function runCodexCli(codexPath: string, args: Array<string>): Promise<number> {
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

function spawnCodexCli(codexPath: string, args: Array<string>): ChildProcess {
    const options: SpawnOptions = {
        env: process.env,
        stdio: "inherit",
        shell: process.platform === "win32",
    };

    return spawn(codexPath, args, options);
}
