import * as acp from "@agentclientprotocol/sdk";
import {existsSync, readFileSync} from "node:fs";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {CodexAppServerClient} from "../../../CodexAppServerClient";
import {prepareCodexHookConfig} from "../../../CodexHookConfig";
import {CODEX_HOOKS_LIST_METHOD, CODEX_HOOKS_TRUST_METHOD, listCodexHooks, trustCodexHooks} from "../../../CodexHookTrust";
import {startCodexConnection} from "../../../CodexJsonRpcConnection";
import type {HookMetadata} from "../../../app-server/v2/HookMetadata";
import {requireLiveApiKey} from "./acp-e2e-test-utils";
import {createSpawnedAgentFixture, type SpawnedAgentFixture} from "./spawned-agent-fixture";

const hasLiveApiKey = Boolean(process.env["CODEX_API_KEY"] || process.env["OPENAI_API_KEY"]);

describe.skipIf(process.env["RUN_E2E_TESTS"] !== "true")("ACP hook review", () => {
    it("fails initialize with the Codex error when hook config is invalid", async () => {
        let failure: unknown;
        const fixture = await createSpawnedAgentFixture(async connection => {
            failure = await connection.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: []}}}},
                clientInfo: {name: "hook-config-test", version: "1"},
            }).catch(error => error);
        }, {
            CODEX_CONFIG: JSON.stringify({hooks: {SessionStart: "invalid"}}),
        });
        try {
            expect((failure as Error).message).toMatch(/Codex process has exited[\s\S]*hooks/);
        } finally {
            await fixture.dispose();
        }
    }, 30_000);

    it("keeps user config hooks and leaves their trust unchanged", async () => {
        const home = await mkdtemp(join(tmpdir(), "codex-hook-test-"));
        await writeFile(join(home, "config.toml"),
            '[hooks]\nPostToolUse = [{matcher = "Bash", hooks = [{type = "command", command = "echo user"}]}]\n');
        const config = prepareCodexHookConfig({
            hooks: {PostToolUse: [{matcher: "Bash", hooks: [{type: "command", command: "echo ready"}]}]},
        });
        const connection = startCodexConnection(undefined, {...process.env, CODEX_HOME: home}, config.appServerStartupArgs);
        const client = new CodexAppServerClient(connection.connection);
        const userHook = async () => (await client.hooksList({cwds: [home]})).data[0]?.hooks.find(hook => hook.source === "user");
        try {
            await client.initialize({
                clientInfo: {name: "codex-hook-test", title: null, version: "1"},
                capabilities: {experimentalApi: true, requestAttestation: false},
            });
            connection.connection.sendNotification("initialized", {});
            expect(await userHook()).toMatchObject({command: "echo user", trustStatus: "untrusted"});

            const hooks = (await listCodexHooks(client, home)).hooks;
            expect(await trustCodexHooks(client, home, hooks.map(({key, currentHash}) => ({key, currentHash})))).toBe(true);
            expect(await userHook()).toMatchObject({command: "echo user", trustStatus: "untrusted"});
        } finally {
            connection.connection.dispose();
            connection.process.kill();
            await rm(home, {recursive: true, force: true});
        }
    }, 30_000);

    it.skipIf(!hasLiveApiKey)("does not run an untrusted hook, runs it after consent, and restores startup hooks after restart", async () => {
        let fixture = await createSpawnedAgentFixture(async connection => {
            const initialized = await connection.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: []}}}},
                clientInfo: {name: "hook-test", version: "1"},
            });
            const jetbrains = initialized._meta?.["jetbrains"] as {air?: {capabilities?: string[]}} | undefined;
            expect(jetbrains?.air?.capabilities).toContain("codexHooks");
            await connection.authenticate({
                methodId: "api-key",
                _meta: {"api-key": {apiKey: requireLiveApiKey()}},
            });
        }, {
            CODEX_PATH: join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex"),
            CODEX_CONFIG: JSON.stringify({
                hooks: {
                    SessionStart: [{hooks: [{
                        type: "command",
                        command: "node -e \"require('node:fs').writeFileSync('hook.log','started')\"",
                    }]}],
                },
            }),
        });
        try {
            const marker = join(fixture.workspaceDir, "hook.log");
            const firstList = await fixture.connection.extMethod(CODEX_HOOKS_LIST_METHOD, {cwd: fixture.workspaceDir});
            const hooks = firstList["hooks"] as HookMetadata[];
            expect(hooks).toHaveLength(1);
            expect(hooks[0]).toMatchObject({source: "sessionFlags", trustStatus: "untrusted"});

            // Codex runs SessionStart hooks with the first turn of a thread, not on thread/start.
            const untrusted = await fixture.createSession();
            expect((await prompt(fixture, untrusted.sessionId)).stopReason).toBe("end_turn");
            expect(existsSync(marker)).toBe(false);
            // A session without messages is never persisted by Codex, so the provider restart below cannot resume it.
            const empty = await fixture.createSession();

            const trust = await fixture.connection.extMethod(CODEX_HOOKS_TRUST_METHOD, {
                cwd: fixture.workspaceDir,
                hooks: [{key: hooks[0]!.key, currentHash: hooks[0]!.currentHash}],
            });
            expect(trust).toEqual({trusted: true});

            await fixture.connection.unstable_disableProvider({providerId: "openai"});
            const restartedList = await fixture.connection.extMethod(CODEX_HOOKS_LIST_METHOD, {cwd: fixture.workspaceDir});
            const hooksAfterRestart = restartedList["hooks"] as HookMetadata[];
            expect(hooksAfterRestart).toHaveLength(1);
            expect(hooksAfterRestart[0]).toMatchObject({key: hooks[0]!.key, trustStatus: "trusted"});
            await expect(prompt(fixture, empty.sessionId)).rejects.toMatchObject({
                message: expect.stringContaining("had no messages yet and was lost"),
            });

            const trusted = await fixture.createSession();
            expect((await prompt(fixture, trusted.sessionId)).stopReason).toBe("end_turn");
            await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {timeout: 10_000});
            expect(readFileSync(marker, "utf8")).toBe("started");
        } finally {
            await fixture.dispose();
        }
    }, 120_000);
});

function prompt(fixture: SpawnedAgentFixture, sessionId: string): Promise<acp.PromptResponse> {
    return fixture.connection.prompt({sessionId, prompt: [{type: "text", text: "Reply with the single word OK."}]});
}
