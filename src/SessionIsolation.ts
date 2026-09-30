import {rmSync} from "node:fs";
import {chmod, copyFile, mkdtemp, rm} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";

export interface SessionIsolation {
    ephemeral: boolean;
    ignoreUserConfig: boolean;
}

export function readSessionIsolation(env: NodeJS.ProcessEnv = process.env): SessionIsolation {
    const flag = (name: string): boolean => {
        const value = env[name];
        if (value === undefined || value === "0" || value === "false") return false;
        if (value === "1" || value === "true") return true;
        throw new Error(`${name} must be 1, 0, true, or false`);
    };
    return {ephemeral: flag("CODEX_EPHEMERAL"), ignoreUserConfig: flag("CODEX_IGNORE_USER_CONFIG")};
}

// Keep the user's auth file, but exclude user configuration and instructions.
// Project configuration and AGENTS.md are still loaded from the requested cwd.
export async function prepareIsolatedHome(env: NodeJS.ProcessEnv = process.env) {
    if (!readSessionIsolation(env).ignoreUserConfig) {
        return {env, cleanup: async () => {}, cleanupSync: () => {}};
    }
    const home = await mkdtemp(join(tmpdir(), "codex-acp-isolated-"));
    const cleanup = () => rm(home, {recursive: true, force: true});
    try {
        await chmod(home, 0o700);
        const auth = join(home, "auth.json");
        try {
            await copyFile(join(env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"), auth);
            await chmod(auth, 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return {env: {...env, CODEX_HOME: home}, cleanup, cleanupSync: () => rmSync(home, {recursive: true, force: true})};
    } catch (error) {
        await cleanup();
        throw error;
    }
}
