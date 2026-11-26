import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdirSync, mkdtempSync} from "node:fs";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: ACP v2 prompt retries", () => {
    it("finds a persisted receipt after restarting the adapter and does not reuse it in a fork", async () => {
        const mock = await startMockResponsesServer();
        mock.setResponseHandler(() => textResponse("OK"));
        const temp = join(process.cwd(), "tmp");
        mkdirSync(temp, {recursive: true});
        const root = mkdtempSync(join(temp, "v2-prompt-retry-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model,
            model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled",
        });
        const methods = acp.methods.agent;
        const withAgent = async <T>(run: (agent: acp.ClientContext, updates: acp.UpdateSessionNotification[]) => Promise<T>): Promise<T> => {
            const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
                cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome},
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", chunk => { stderr += chunk.toString(); });
            const updates: acp.UpdateSessionNotification[] = [];
            const connection = acp.client()
                .onNotification(acp.methods.client.session.update, ({params}) => { updates.push(params); })
                .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
            try {
                const agent = connection.agent;
                await agent.request(methods.initialize, {
                    protocolVersion: 2, info: {name: "vitest", version: "1"},
                    capabilities: {auth: {_meta: {gateway: true}}},
                });
                await agent.request(methods.auth.login, {
                    methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
                });
                return await run(agent, updates);
            } catch (error) {
                if (stderr) console.error(stderr);
                throw error;
            } finally {
                connection.close();
                child.stdin.end();
                if (child.exitCode === null && child.signalCode === null) {
                    const timeout = setTimeout(() => child.kill(), 4_000);
                    try { await once(child, "exit"); }
                    finally { clearTimeout(timeout); }
                }
            }
        };
        const prompt = {
            idempotencyKey: "test-submission-key",
            prompt: [{type: "text" as const, text: "Reply with OK"}],
        };
        const waitForIdle = (updates: acp.UpdateSessionNotification[], session: string) => vi.waitFor(() => {
            expect(updates.some(({sessionId, update}) => sessionId === session
                && acp.SessionUpdate.isStateUpdate(update) && update.state === "idle"
                && "stopReason" in update && update.stopReason === "end_turn")).toBe(true);
        }, {timeout: 10_000});
        try {
            const {sessionId, messageId} = await withAgent(async (agent, updates) => {
                const {sessionId} = await agent.request(methods.session.new, {cwd});
                const {messageId} = await agent.request(methods.session.prompt, {sessionId, ...prompt});
                await waitForIdle(updates, sessionId);
                await agent.request(methods.session.close, {sessionId});
                return {sessionId, messageId};
            });
            await withAgent(async (agent, updates) => {
                const calls = mock.promptRequests.length;
                await agent.request(methods.session.resume, {cwd, sessionId});
                await expect(agent.request(methods.session.prompt, {sessionId, ...prompt})).resolves.toEqual({messageId});
                expect(mock.promptRequests).toHaveLength(calls);
                expect(updates.some(({update}) => acp.SessionUpdate.isUserMessageChunk(update))).toBe(false);

                await agent.request(methods.session.resume, {cwd, sessionId, replayFrom: {type: "start"}});
                const replayed = updates.filter(({update}) => acp.SessionUpdate.isUserMessageChunk(update));
                expect(replayed).toEqual([expect.objectContaining({update: expect.objectContaining({messageId})})]);
                expect(JSON.stringify(updates)).not.toContain(prompt.idempotencyKey);

                const fork = await agent.request(methods.session.fork, {cwd, sessionId});
                const forkReceipt = await agent.request(methods.session.prompt, {...prompt, sessionId: fork.sessionId});
                expect(forkReceipt.messageId).not.toBe(messageId);
                await waitForIdle(updates, fork.sessionId);
                await agent.request(methods.session.close, {sessionId: fork.sessionId});
                await agent.request(methods.session.close, {sessionId});
                // Deleting the inactive session must also make its retained receipt unreachable.
                await agent.request(methods.session.delete, {sessionId});
                const missing = {code: -32002, data: {sessionId}};
                await expect(agent.request(methods.session.options, {cwd, sessionId})).rejects.toMatchObject(missing);
                await expect(agent.request(methods.session.resume, {cwd, sessionId})).rejects.toMatchObject(missing);
                await expect(agent.request(methods.session.fork, {cwd, sessionId})).rejects.toMatchObject(missing);
                await expect(agent.request(methods.session.setTitle, {sessionId, title: "Too late"})).rejects.toMatchObject(missing);
            });
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            await mock.close();
            removeDirectoryWithRetry(root);
        }
    });
});
