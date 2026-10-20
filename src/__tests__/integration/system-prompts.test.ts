import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync, mkdirSync, mkdtempSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";
import {developerText, findPromptRequest} from "./model-request";

describeIntegration("integration: client system prompts", () => {
    it.each([1, 2] as const)("applies and defers instructions through ACP v%s", async (version) => {
        const mock = await startMockResponsesServer();
        // Codex may populate plugin caches with their own tests; keep them out of Vitest discovery.
        const temporaryRoot = join(process.cwd(), "node_modules", ".cache", "codex-acp-tests");
        mkdirSync(temporaryRoot, {recursive: true});
        const root = mkdtempSync(join(temporaryRoot, "system-prompts-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model,
            model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled",
            developer_instructions: "CONFIGURED_BASE_INSTRUCTIONS",
            // Ephemeral title threads use the native provider, not the session gateway.
            model_provider: "integration",
            "model_providers.integration.name": "Local integration mock",
            "model_providers.integration.base_url": mock.baseUrl,
            "model_providers.integration.wire_api": "responses",
        });
        const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome, APP_SERVER_LOGS: root}, stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        const updates: Array<{sessionId: string; update: any}> = [];
        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin),
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        );
        const connection = version === 1
            ? acp.client().onNotification(acp.methods.client.session.update, ctx => { updates.push(ctx.params); }).connect(stream)
            : acpV2.client().onNotification(acpV2.methods.client.session.update, ctx => { updates.push(ctx.params); }).connect(stream);
        // The untyped request overload is shared by both protocol contexts.
        const context = connection.agent as {
            request(method: string, params: unknown, options: {cancellationSignal: AbortSignal}): Promise<unknown>;
        };
        const request = async (method: string, params: unknown): Promise<any> => {
            try {
                return await context.request(method, params, {cancellationSignal: AbortSignal.timeout(15_000)});
            } catch (error) {
                if (error instanceof Error) {
                    const log = join(root, "app-server.log");
                    error.message = `${method} ${JSON.stringify(params)}: ${error.message}\n${stderr}\n${existsSync(log) ? readFileSync(log, "utf8") : ""}`;
                }
                throw error;
            }
        };
        const systemPrompt = (text: string) => ({mode: "append", content: [{type: "text", text}]});

        async function run(sessionId: string, text: string) {
            const before = mock.requests.length;
            const updateStart = updates.length;
            // Title generation may make a second request after the first prompt of a session.
            mock.enqueue(textResponse("Done"), textResponse("System prompt test"));
            const response = await request("session/prompt", {sessionId, prompt: [{type: "text", text}]});
            if (version === 2) {
                await vi.waitFor(() => {
                    expect(updates.slice(updateStart).some(entry => entry.sessionId === sessionId
                        && entry.update.sessionUpdate === "state_update" && entry.update.state === "idle"), stderr).toBe(true);
                }, {timeout: 10_000});
            } else {
                expect(response.stopReason, stderr).toBe("end_turn");
            }
            // Start the next probe immediately after ACP completion, without a runtime-log wait.
            if (text === "/compact") return;
            const modelRequest = findPromptRequest(mock.requests.slice(before), text);
            expect(modelRequest, `No model request contained the user message: ${text}`).toBeDefined();
            return modelRequest;
        }
        async function expectInstructions(sessionId: string, marker: string, absent?: string) {
            const body = await run(sessionId, `Check ${marker}`);
            const developer = developerText(body);
            expect(developer).toContain(marker);
            expect(developer).toContain("AIR_BASE_INSTRUCTIONS");
            if (absent) expect(developer).not.toContain(absent);
        }
        try {
            const initialized = await request("initialize", version === 1 ? {
                protocolVersion: 1, clientInfo: {name: "prompt-test", version: "1"},
                clientCapabilities: {auth: {_meta: {gateway: true}}},
            } : {
                protocolVersion: 2, info: {name: "prompt-test", version: "1"},
                capabilities: {auth: {_meta: {gateway: true}}},
            });
            expect(version === 1
                ? initialized.agentCapabilities.sessionCapabilities.systemPrompt
                : initialized.capabilities.session.systemPrompt).toEqual({});
            await request(version === 1 ? "authenticate" : "auth/login", {
                methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
            });
            const {sessionId} = await request("session/new", {
                cwd, mcpServers: [], systemPrompt: systemPrompt("ORIGINAL_CLIENT_INSTRUCTIONS"),
                _meta: {jetbrains: {air: {customInstructions: "AIR_BASE_INSTRUCTIONS"}}},
            });
            // No rollout exists yet: a changed prompt must leave this original session usable.
            await expect(request("session/resume", {
                sessionId, cwd, mcpServers: [], systemPrompt: systemPrompt("UNUSED_CLIENT_INSTRUCTIONS"),
            })).rejects.toMatchObject({code: -32602});
            await expectInstructions(sessionId, "ORIGINAL_CLIENT_INSTRUCTIONS", "UNUSED_CLIENT_INSTRUCTIONS");
            await request("session/resume", {
                sessionId, cwd, mcpServers: [], systemPrompt: systemPrompt("UPDATED_CLIENT_INSTRUCTIONS"),
            });
            await expectInstructions(sessionId, "ORIGINAL_CLIENT_INSTRUCTIONS", "UPDATED_CLIENT_INSTRUCTIONS");
            await run(sessionId, "/compact");
            await expectInstructions(sessionId, "UPDATED_CLIENT_INSTRUCTIONS", "ORIGINAL_CLIENT_INSTRUCTIONS");

            const fork = await request("session/fork", {
                sessionId, cwd, mcpServers: [], systemPrompt: systemPrompt("FORK_CLIENT_INSTRUCTIONS"),
            });
            await run(fork.sessionId, "/compact");
            await expectInstructions(fork.sessionId, "FORK_CLIENT_INSTRUCTIONS", "UPDATED_CLIENT_INSTRUCTIONS");

            await request(version === 1 ? "session/load" : "session/resume", {
                sessionId, cwd, mcpServers: [], systemPrompt: systemPrompt("REPLAY_CLIENT_INSTRUCTIONS"),
                ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
            });
            await run(sessionId, "/compact");
            await expectInstructions(sessionId, "REPLAY_CLIENT_INSTRUCTIONS", "UPDATED_CLIENT_INSTRUCTIONS");
            const configured = await request("session/new", {
                cwd, mcpServers: [], systemPrompt: systemPrompt("CONFIGURED_CLIENT_INSTRUCTIONS"),
            });
            const configuredRequest = await run(configured.sessionId, "Check configured baseline");
            const configuredDeveloper = developerText(configuredRequest);
            expect(configuredDeveloper).toContain("CONFIGURED_BASE_INSTRUCTIONS");
            expect(configuredDeveloper).toContain("CONFIGURED_CLIENT_INSTRUCTIONS");
            expect(configuredDeveloper).not.toContain("AIR_BASE_INSTRUCTIONS");
            expect(mock.unexpectedRequests, stderr).toBe(0);
            await request("session/close", {sessionId: configured.sessionId});
            await request("session/close", {sessionId: fork.sessionId});
            await request("session/close", {sessionId});
        } finally {
            connection.close();
            child.stdin.end();
            if (child.exitCode === null && child.signalCode === null) {
                const timeout = setTimeout(() => child.kill(), 4_000);
                try { await once(child, "exit"); } finally { clearTimeout(timeout); }
            }
            await mock.close();
            removeDirectoryWithRetry(root);
        }
    });
}, 60_000);
