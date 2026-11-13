import {describe, expect, it, vi} from "vitest";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {prepareCodexHookConfig} from "../CodexHookConfig";
import {listCodexHooks, trustCodexHooks} from "../CodexHookTrust";
import type {HooksListResponse} from "../app-server/v2/HooksListResponse";

const cwd = "/work/project";
const hook = {
    key: "session_flags:post_tool_use:0:0",
    eventName: "postToolUse" as const,
    matcher: "Bash",
    source: "sessionFlags" as const,
    currentHash: "expected-hash",
    trustStatus: "untrusted" as const,
    handlerType: "command" as const,
    command: "example-hook",
    async: false,
    timeoutSec: 30n,
    statusMessage: "running hook",
    additionalContextLimit: 500,
    sourcePath: "/work/project/.codex/hooks.toml",
    pluginId: null,
    displayOrder: 2n,
    enabled: true,
    isManaged: false,
};

function response(hooks: unknown[], warnings: string[] = [], errors: {path: string; message: string}[] = []): HooksListResponse {
    return {data: [{cwd, hooks, warnings, errors}]} as HooksListResponse;
}

describe("Codex hook trust", () => {
    it("lists only session-flag hooks", async () => {
        const client = {
            hooksList: vi.fn().mockResolvedValue(response([hook, {...hook, key: "user-hook", source: "user"}])),
        } as unknown as CodexAppServerClient;

        await expect(listCodexHooks(client, cwd)).resolves.toEqual({cwd, hooks: [hook], warnings: [], errors: []});
    });

    it("returns Codex errors alongside hooks instead of hiding all hooks", async () => {
        const errors = [{path: "/other/config.toml", message: "unrelated hook parse error"}];
        const client = {
            hooksList: vi.fn().mockResolvedValue(response([hook], ["another hook was skipped"], errors)),
        } as unknown as CodexAppServerClient;

        await expect(listCodexHooks(client, cwd)).resolves.toMatchObject({
            hooks: [expect.objectContaining({key: hook.key})],
            warnings: ["another hook was skipped"],
            errors,
        });
    });

    it("rechecks the hash before writing and verifies trust after writing", async () => {
        const client = {
            hooksList: vi.fn()
                .mockResolvedValueOnce(response([hook], [], [{path: "/other/config.toml", message: "unrelated error"}]))
                .mockResolvedValueOnce(response([{...hook, trustStatus: "trusted"}], [], [{path: "/other/config.toml", message: "unrelated error"}])),
            configBatchWrite: vi.fn().mockResolvedValue({status: "ok"}),
        } as unknown as CodexAppServerClient;

        await expect(trustCodexHooks(client, cwd, [{key: hook.key, currentHash: hook.currentHash}]))
            .resolves.toBe(true);
        expect(client.configBatchWrite).toHaveBeenCalledWith({
            edits: [{
                keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
                value: hook.currentHash,
                mergeStrategy: "replace",
            }],
            reloadUserConfig: true,
        });
    });

    it("does not write when Codex reports a different hash", async () => {
        const client = {
            hooksList: vi.fn().mockResolvedValue(response([{...hook, currentHash: "changed"}])),
            configBatchWrite: vi.fn(),
        } as unknown as CodexAppServerClient;

        await expect(trustCodexHooks(client, cwd, [{key: hook.key, currentHash: hook.currentHash}]))
            .rejects.toThrow("changed before trust");
        expect(client.configBatchWrite).not.toHaveBeenCalled();
    });
});

describe("Codex hook configuration", () => {
    it("keeps other config in the session and moves hooks to App Server startup", async () => {
        const hooks = {
            PostToolUse: [{matcher: "Bash", hooks: [{type: "command", command: "echo ready"}]}],
        };
        const prepared = prepareCodexHookConfig({model: "gpt-5", hooks});

        expect(prepared.sessionConfig).toEqual({model: "gpt-5"});
        expect(prepared.appServerStartupArgs.slice(0, 2)).toEqual(["app-server", "-c"]);
        await expect(`${prepared.appServerStartupArgs[2]}\n`).toMatchFileSnapshot("data/codex-hook-config-override.txt");
    });

    it("keeps the existing path when config has no hooks", () => {
        expect(prepareCodexHookConfig({model: "gpt-5"})).toEqual({
            sessionConfig: {model: "gpt-5"},
            appServerStartupArgs: ["app-server"],
        });
    });
});
