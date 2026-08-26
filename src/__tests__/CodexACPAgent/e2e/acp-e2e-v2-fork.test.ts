import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import crypto from "node:crypto";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {Readable, Writable} from "node:stream";
import {afterEach, expect, it} from "vitest";
import {writeCodexHomeConfig} from "../../acp-test-utils";
import {describeE2E, requireLiveApiKey} from "./acp-e2e-test-utils";
import {DEFAULT_TEST_MODEL_ID} from "./spawned-agent-fixture";

/**
 * Real end-to-end coverage for ACP v2 `session/fork` against the spawned v2
 * entry (`start:v2` → `codex app-server`): the forked session must be a new
 * independent id that carries the source session's history.
 */
describeE2E("E2E ACP v2 session fork", () => {
    let agentProcess: ChildProcessWithoutNullStreams | null = null;
    let rootDir: string | null = null;

    afterEach(async () => {
        agentProcess?.kill();
        agentProcess = null;
        if (rootDir !== null) {
            fs.rmSync(rootDir, {recursive: true, force: true});
            rootDir = null;
        }
    });

    it("forks a session into a new id that remembers the source history", async () => {
        const apiKey = requireLiveApiKey();
        rootDir = path.join(process.cwd(), "tmp", crypto.randomUUID());
        const codexHome = path.join(rootDir, "codex-home");
        const workspaceDir = path.join(rootDir, "workspace");
        const appServerLogsDir = path.join(rootDir, "logs");
        for (const dir of [rootDir, codexHome, workspaceDir, appServerLogsDir]) {
            fs.mkdirSync(dir, {recursive: true});
        }
        writeCodexHomeConfig(codexHome, {
            model: DEFAULT_TEST_MODEL_ID.model,
            model_reasoning_effort: DEFAULT_TEST_MODEL_ID.effort,
            web_search: "disabled",
        });

        const spawnedProcess = spawn("npm", ["run", "--silent", "start:v2"], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                CODEX_HOME: codexHome,
                APP_SERVER_LOGS: appServerLogsDir,
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        agentProcess = spawnedProcess;
        spawnedProcess.stderr.on("data", (chunk: Buffer) => {
            process.stderr.write(chunk);
        });

        const stream = acpV2.ndJsonStream(
            Writable.toWeb(spawnedProcess.stdin),
            Readable.toWeb(spawnedProcess.stdout) as ReadableStream<Uint8Array>,
        );

        const sessionText = new Map<string, string>();
        const idleSessions = new Set<string>();
        let notifyWaiters: Array<() => void> = [];
        const onSessionNotification = (notification: acpV2.UpdateSessionNotification): void => {
            const update = notification.update;
            if (update.sessionUpdate === "agent_message_chunk") {
                const content = update.content as acpV2.ContentBlock;
                if (content.type === "text") {
                    sessionText.set(
                        notification.sessionId,
                        (sessionText.get(notification.sessionId) ?? "") + content.text,
                    );
                }
            }
            if (update.sessionUpdate === "state_update" && update.state === "idle") {
                idleSessions.add(notification.sessionId);
            }
            const waiters = notifyWaiters;
            notifyWaiters = [];
            for (const wake of waiters) {
                wake();
            }
        };
        const waitForIdle = async (sessionId: string, timeoutMs = 120_000): Promise<void> => {
            const deadline = Date.now() + timeoutMs;
            while (!idleSessions.has(sessionId)) {
                if (Date.now() > deadline) {
                    throw new Error(`Timed out waiting for session ${sessionId} to become idle`);
                }
                await new Promise<void>((resolve) => {
                    notifyWaiters.push(resolve);
                    setTimeout(resolve, 1000);
                });
            }
            idleSessions.delete(sessionId);
        };

        await acpV2.client({name: "acp-e2e-v2-fork"})
            .onNotification(acpV2.methods.client.session.update, (ctx) => onSessionNotification(ctx.params))
            .connectWith(stream, async (context) => {
                const initializeResponse = await context.request(acpV2.methods.agent.initialize, {
                    protocolVersion: acpV2.PROTOCOL_VERSION,
                    info: {name: "acp-e2e-v2-fork", version: "test"},
                    capabilities: {},
                });
                expect(initializeResponse.capabilities?.session?.fork).toBeDefined();

                await context.request(acpV2.methods.agent.auth.login, {
                    methodId: "api-key",
                    _meta: {"api-key": {apiKey}},
                } as acpV2.LoginAuthRequest);

                const created = await context.request(acpV2.methods.agent.session.new, {cwd: workspaceDir});
                const sourceSessionId = created.sessionId;

                const memorizedToken = `fork-token-${crypto.randomUUID().slice(0, 8)}`;
                await context.request(acpV2.methods.agent.session.prompt, {
                    sessionId: sourceSessionId,
                    prompt: [{
                        type: "text",
                        text: `Remember this token - "${memorizedToken}". Reply with exactly source-ok and nothing else.`,
                    }],
                });
                await waitForIdle(sourceSessionId);
                expect(sessionText.get(sourceSessionId)?.toLowerCase()).toContain("source-ok");

                const forked = await context.request(acpV2.methods.agent.session.fork, {
                    sessionId: sourceSessionId,
                    cwd: workspaceDir,
                });
                expect(forked.sessionId).not.toBe(sourceSessionId);

                await context.request(acpV2.methods.agent.session.prompt, {
                    sessionId: forked.sessionId,
                    prompt: [{
                        type: "text",
                        text: "What token did I ask you to remember earlier? Reply with just the token and nothing else.",
                    }],
                });
                await waitForIdle(forked.sessionId);
                expect(sessionText.get(forked.sessionId)).toContain(memorizedToken);
            });
    }, 300_000);
}, 320_000);
