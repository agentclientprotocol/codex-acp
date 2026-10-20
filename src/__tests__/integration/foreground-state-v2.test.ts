import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdirSync, mkdtempSync} from "node:fs";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: ACP v2 foreground state", () => {
    it("reports a structured auth failure, recovers, and synchronizes state on resume", async () => {
        const mock = await startMockResponsesServer();
        const temporaryRoot = join(process.cwd(), "tmp");
        mkdirSync(temporaryRoot, {recursive: true});
        const root = mkdtempSync(join(temporaryRoot, "v2-foreground-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model,
            model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled",
        });
        const processHandle = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(),
            env: {...process.env, CODEX_HOME: codexHome},
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        processHandle.stderr.on("data", chunk => { stderr += chunk.toString(); });
        const updates: acpV2.UpdateSessionNotification[] = [];
        const connection = acpV2.client()
            .onNotification(acpV2.methods.client.session.update, ctx => { updates.push(ctx.params); })
            .connect(acpV2.ndJsonStream(
                Writable.toWeb(processHandle.stdin),
                Readable.toWeb(processHandle.stdout) as ReadableStream<Uint8Array>,
            ));
        try {
            await connection.agent.request(acpV2.methods.agent.initialize, {
                protocolVersion: 2,
                info: {name: "vitest-v2", version: "1"},
                capabilities: {auth: {_meta: {gateway: true}}},
            });
            await connection.agent.request(acpV2.methods.agent.auth.login, {
                methodId: "gateway",
                _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
            });
            const failedSession = await connection.agent.request(acpV2.methods.agent.session.new, {cwd});
            expect(failedSession.availableCommands).toEqual(expect.arrayContaining([
                expect.objectContaining({name: "review", input: {type: "text", hint: "optional review instructions"}}),
            ]));
            expect(updates.some(({update}) => update.sessionUpdate === "available_commands_update")).toBe(false);
            mock.setErrorResponse({
                status: 401,
                body: {error: {type: "authentication_error", message: "Mock authentication required", debug: "private diagnostics"}},
            });
            const accepted = await connection.agent.request(acpV2.methods.agent.session.prompt, {
                sessionId: failedSession.sessionId,
                prompt: [{type: "text", text: "Trigger an authentication failure"}],
            });
            expect(accepted.messageId).toEqual(expect.any(String));
            await vi.waitFor(() => {
                expect(updates.some(({sessionId, update}) => sessionId === failedSession.sessionId
                    && update.sessionUpdate === "state_update" && update.state === "idle"), stderr).toBe(true);
            }, {timeout: 10_000});
            const failedIdle = updates.filter(({sessionId, update}) => sessionId === failedSession.sessionId
                && update.sessionUpdate === "state_update" && update.state === "idle").at(-1)?.update;
            expect(failedIdle).toMatchObject({
                state: "idle", stopReason: "error", error: {code: -32000, message: "Authentication required"},
            });
            expect(JSON.stringify(failedIdle)).not.toContain("private diagnostics");
            mock.setErrorResponse(null);
            await connection.agent.request(acpV2.methods.agent.session.close, {sessionId: failedSession.sessionId});
            updates.splice(0);

            const {sessionId} = await connection.agent.request(acpV2.methods.agent.session.new, {cwd});
            mock.enqueue(textResponse("v2-", "foreground-ok"), textResponse("V2 foreground test"));
            const {messageId} = await connection.agent.request(acpV2.methods.agent.session.prompt, {
                sessionId,
                prompt: [{type: "text", text: "Reply with v2-foreground-ok"}],
            });
            await vi.waitFor(() => {
                expect(updates.some(({update}) => update.sessionUpdate === "state_update"
                    && update.state === "idle"), stderr).toBe(true);
            });
            const states = updates.flatMap(({update}) =>
                update.sessionUpdate === "state_update" ? [update.state] : []);
            expect(states).toEqual(["running", "idle"]);
            const running = updates.findIndex(({update}) => update.sessionUpdate === "state_update" && update.state === "running");
            const user = updates.findIndex(({update}) => update.sessionUpdate === "user_message_chunk" && update.messageId === messageId);
            expect(user).toBeGreaterThan(running);
            expect(updates.flatMap(({update}) => acpV2.SessionUpdate.isAgentMessageChunk(update)
                && acpV2.ContentBlock.isText(update.content) ? [update.content.text] : []).join("")).toBe("v2-foreground-ok");

            for (const replayFrom of [undefined, null, {type: "start" as const}]) {
                updates.splice(0);
                const resumed = await connection.agent.request(acpV2.methods.agent.session.resume, {
                    sessionId, cwd, ...(replayFrom === undefined ? {} : {replayFrom}),
                });
                expect(resumed.availableCommands).toEqual(failedSession.availableCommands);
                expect(updates.some(({update}) => update.sessionUpdate === "available_commands_update")).toBe(false);
                expect(updates.filter(({update}) => update.sessionUpdate === "state_update").map(({update}) => update))
                    .toEqual([{sessionUpdate: "state_update", state: "idle"}]);
                const replayedMessages = updates.some(({update}) => update.sessionUpdate === "user_message"
                    || update.sessionUpdate === "user_message_chunk");
                expect(replayedMessages).toBe(replayFrom != null);
            }
            updates.splice(0);
            const fork = await connection.agent.request(acpV2.methods.agent.session.fork, {sessionId, cwd});
            expect(fork.availableCommands).toEqual(failedSession.availableCommands);
            expect(updates.some(({update}) => update.sessionUpdate === "available_commands_update")).toBe(false);
            await connection.agent.request(acpV2.methods.agent.session.close, {sessionId: fork.sessionId});
            expect(mock.unexpectedRequests).toBe(0);
            await connection.agent.request(acpV2.methods.agent.session.close, {sessionId});
        } finally {
            connection.close();
            if (!processHandle.stdin.destroyed && !processHandle.stdin.writableEnded) processHandle.stdin.end();
            if (processHandle.exitCode === null && processHandle.signalCode === null) {
                const timeout = setTimeout(() => processHandle.kill(), 4_000);
                try {
                    await once(processHandle, "exit");
                } finally {
                    clearTimeout(timeout);
                }
            }
            await mock.close();
            removeDirectoryWithRetry(root);
        }
    });
});
