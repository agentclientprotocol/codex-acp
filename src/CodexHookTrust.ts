import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {HookMetadata} from "./app-server/v2/HookMetadata";
import type {HooksListEntry} from "./app-server/v2/HooksListEntry";

export const CODEX_HOOKS_LIST_METHOD = "_codex/hooks/list";
export const CODEX_HOOKS_TRUST_METHOD = "_codex/hooks/trust";

export type CodexHookIdentity = {key: string; currentHash: string};

/** Lists the hooks passed at App Server startup, with Codex warnings and errors for the directory. */
export async function listCodexHooks(client: CodexAppServerClient, cwd: string): Promise<HooksListEntry> {
    const [entry] = (await client.hooksList({cwds: [cwd]})).data;
    if (entry === undefined) throw new Error("Codex could not list hooks for the requested directory");
    return {...entry, hooks: entry.hooks.filter(hook => hook.source === "sessionFlags")};
}

/** Trusts the requested startup hooks only if their hashes still match, then confirms Codex reports them trusted. */
export async function trustCodexHooks(
    client: CodexAppServerClient,
    cwd: string,
    requested: CodexHookIdentity[],
): Promise<boolean> {
    const isListed = (hooks: HookMetadata[], request: CodexHookIdentity) =>
        hooks.find(hook => hook.key === request.key && hook.currentHash === request.currentHash);

    const current = (await listCodexHooks(client, cwd)).hooks;
    const edits = requested.map(request => {
        const hook = isListed(current, request);
        if (hook === undefined) throw new Error("A Codex hook changed before trust was recorded");
        return hook;
    }).filter(hook => hook.trustStatus !== "trusted").map(hook => ({
        keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
        value: hook.currentHash,
        mergeStrategy: "replace" as const,
    }));
    if (edits.length > 0) {
        await client.configBatchWrite({edits, reloadUserConfig: true});
    }
    const verified = (await listCodexHooks(client, cwd)).hooks;
    return requested.every(request => isListed(verified, request)?.trustStatus === "trusted");
}
