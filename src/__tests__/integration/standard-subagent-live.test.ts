import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {appendFileSync, mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {AgentMode} from "../../AgentMode";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {functionCallResponse, startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: live standard subagents", () => {
    it.each(([1, 2] as const).flatMap(version =>
        (["complete", "cancel", "child-cancel", "close", "terminal"] as const).map(ending => ({version, ending})),
    ))("keeps live child delivery and ownership through ACP v$version reattachment ($ending)", async ({version, ending}) => {
        const mock = await startMockResponsesServer();
        let delegated = false;
        let childRequested = false;
        let childEffort: string | undefined;
        let releaseChild!: () => void;
        const held = new Promise<void>(resolve => { releaseChild = resolve; });
        mock.setResponseHandler(async request => {
            const metadata = (request as {client_metadata?: Record<string, string>}).client_metadata?.["x-codex-turn-metadata"];
            const name = metadata ? (JSON.parse(metadata) as {agent_name?: string}).agent_name : undefined;
            if (!childRequested && name === "/root/worker") {
                childRequested = true;
                childEffort = (request as {reasoning?: {effort?: string}}).reasoning?.effort;
                await held;
                if (ending === "terminal") {
                    const script = "console.log('STREAM_BEFORE');const t=setInterval(()=>{if(require('fs').existsSync('release-child')){console.log('STREAM_AFTER');clearInterval(t)}},25)";
                    return functionCallResponse("worker-command", "exec_command", {
                        cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, yield_time_ms: 30_000,
                    });
                }
                return textResponse("CHILD_RESULT");
            }
            if ((request as {model?: string}).model === INTEGRATION_MODEL_ID.model && !delegated) {
                delegated = true;
                return functionCallResponse("delegate-once", "spawn_agent", {
                    message: "Reply with CHILD_RESULT", task_name: "worker", fork_turns: "none",
                }, "collaboration");
            }
            return textResponse("CHILD_RESULT");
        });
        const temporaryRoot = join(process.cwd(), "node_modules", ".cache", "codex-acp-tests");
        mkdirSync(temporaryRoot, {recursive: true});
        const root = mkdtempSync(join(temporaryRoot, "standard-live-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model, model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled", model_provider: "integration",
            "model_providers.integration.name": "Local integration mock",
            "model_providers.integration.base_url": mock.baseUrl, "model_providers.integration.wire_api": "responses",
        });
        appendFileSync(join(codexHome, "config.toml"), "\nfeatures.multi_agent = true\nfeatures.multi_agent_v2 = true\n");
        const processHandle = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome,
                // Only the fixed local fixture script bypasses host sandbox restrictions.
                ...(ending === "terminal" ? {INITIAL_AGENT_MODE: AgentMode.AgentFullAccess.id} : {})},
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        processHandle.stderr.on("data", chunk => { stderr += chunk.toString(); });
        const updates: Array<{sessionId: string; update: any}> = [];
        const stream = acp.ndJsonStream(Writable.toWeb(processHandle.stdin), Readable.toWeb(processHandle.stdout) as ReadableStream<Uint8Array>);
        const connection = version === 1
            ? acp.client().onNotification(acp.methods.client.session.update, ctx => { updates.push(ctx.params); }).connect(stream)
            : acpV2.client().onNotification(acpV2.methods.client.session.update, ctx => { updates.push(ctx.params); }).connect(stream);
        const context = connection.agent as {
            request(method: string, params: unknown, options: {cancellationSignal: AbortSignal}): Promise<any>;
            notify(method: string, params: unknown): Promise<void>;
        };
        const request = async (method: string, params: unknown) => {
            try { return await context.request(method, params, {cancellationSignal: AbortSignal.timeout(15_000)}); }
            catch (error) { if (error instanceof Error) error.message = `${method}: ${error.message}\n${stderr}`; throw error; }
        };
        try {
            await request("initialize", version === 1
                ? {protocolVersion: 1, clientCapabilities: {subagents: {}, auth: {_meta: {gateway: true}}}}
                : {protocolVersion: 2, info: {name: "standard-live-test", version: "1"}, capabilities: {auth: {_meta: {gateway: true}}}});
            await request(version === 1 ? "authenticate" : "auth/login", {
                methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
            });
            const {sessionId} = await request("session/new", {cwd, mcpServers: []});
            const prompt = request("session/prompt", {sessionId, prompt: [{type: "text", text: "Delegate once"}]});
            void prompt.catch(() => {});
            await vi.waitFor(() => {
                expect(childRequested, stderr).toBe(true);
                expect(updates.some(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === "subagent_update")).toBe(true);
            }, {timeout: 15_000});
            const childId = updates.find(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === "subagent_update")!.update.sessionId;
            const state = (entry: typeof updates[number]) => version === 1
                ? entry.update.sessionUpdate === "subagent_update" && entry.update.sessionId === childId ? entry.update.state : undefined
                : entry.sessionId === childId && entry.update.sessionUpdate === "state_update" ? entry.update : undefined;
            const configuration = (entry: typeof updates[number]) =>
                entry.sessionId === childId && entry.update.sessionUpdate === "config_option_update";
            const effortReported = (entries: typeof updates) => entries.some(entry => configuration(entry)
                && entry.update.configOptions.some((option: {category?: string; currentValue: string; options: Array<{value: string}>}) =>
                    option.category === "thought_level" && option.currentValue === childEffort
                    && option.options.length === 1 && option.options[0]?.value === childEffort));
            const cancelGranted = (entries: typeof updates) => entries.some(entry =>
                entry.update.sessionUpdate === "subagent_update" && entry.update.sessionId === childId
                && entry.update.capabilities?.cancel != null);
            await vi.waitFor(() => expect(updates.some(entry => state(entry)?.state === "running")).toBe(true));
            await vi.waitFor(() => expect(updates.some(configuration)).toBe(true));
            await vi.waitFor(() => expect(cancelGranted(updates)).toBe(true));
            expect(childEffort).toBeDefined();
            await vi.waitFor(() => expect(effortReported(updates)).toBe(true));
            await prompt;
            const load = (id: string) => request(version === 1 ? "session/load" : "session/resume", {
                sessionId: id, cwd, mcpServers: [], ...(version === 2 ? {replayFrom: {type: "start"}} : {}),
            });
            const before = updates.length;
            await load(sessionId);
            await vi.waitFor(() => expect(updates.slice(before).some(entry => state(entry)?.state === "running")).toBe(true));
            await vi.waitFor(() => expect(updates.slice(before).some(configuration)).toBe(true));
            await vi.waitFor(() => expect(effortReported(updates.slice(before))).toBe(true));
            await vi.waitFor(() => expect(cancelGranted(updates.slice(before))).toBe(true));
            if (ending === "complete") {
                const fork = await request("session/fork", {sessionId, cwd, mcpServers: []});
                await load(fork.sessionId);
                const copied = updates.filter(entry => entry.sessionId === fork.sessionId && entry.update.sessionUpdate === "subagent_update");
                expect(copied.length).toBeGreaterThan(0);
                expect(copied.every(entry => entry.update.sessionId !== childId)).toBe(true);
                await request("session/close", {sessionId: fork.sessionId});
            } else if (ending === "terminal") {
                releaseChild();
                await vi.waitFor(() => expect(updates.some(entry => entry.sessionId === childId && (version === 2
                    ? entry.update.sessionUpdate === "terminal_update" && typeof entry.update.command === "string"
                    : entry.update._meta?.terminal_info)), stderr).toBe(true), {timeout: 15_000});
                await request("session/prompt", {sessionId, prompt: [{type: "text", text: "Continue independently"}]});
                const terminalStart = updates.length;
                writeFileSync(join(cwd, "release-child"), "");
                await vi.waitFor(() => {
                    const newer = updates.slice(terminalStart).filter(entry => entry.sessionId === childId);
                    expect(newer.some(entry => version === 2
                        ? entry.update.sessionUpdate === "terminal_output_chunk" && Buffer.from(entry.update.data, "base64").toString().includes("STREAM_AFTER")
                        : entry.update._meta?.terminal_output?.data?.includes("STREAM_AFTER")
                            || entry.update._meta?.terminal_output_delta?.data?.includes("STREAM_AFTER"))).toBe(true);
                    expect(newer.some(entry => version === 2
                        ? entry.update.sessionUpdate === "terminal_update" && entry.update.exitStatus?.exitCode === 0
                        : entry.update._meta?.terminal_exit?.exit_code === 0)).toBe(true);
                }, {timeout: 15_000});
            } else if (ending === "child-cancel") {
                const boundary = updates.length;
                await context.notify("session/cancel", {sessionId: childId});
                await vi.waitFor(() => expect(updates.slice(boundary).some(entry =>
                    state(entry)?.state === "idle" && state(entry)?.stopReason === "cancelled"), stderr).toBe(true), {timeout: 15_000});
                await request("session/prompt", {sessionId, prompt: [{type: "text", text: "Continue independently"}]});
            } else {
                const boundary = updates.length;
                if (ending === "cancel") await context.notify("session/cancel", {sessionId});
                else await request("session/close", {sessionId});
                await vi.waitFor(() => expect(updates.slice(boundary).some(entry => {
                    const current = state(entry);
                    return ending === "close" ? current?.state === "unknown"
                        : current?.state === "idle" && current.stopReason === "cancelled";
                }), stderr).toBe(true), {timeout: 15_000});
            }
            releaseChild();
            if (ending === "complete" || ending === "terminal") await vi.waitFor(() => {
                const announcement = updates.findIndex(entry => entry.sessionId === sessionId && entry.update.sessionUpdate === "subagent_update");
                const message = updates.findIndex(entry => entry.sessionId === childId
                    && entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.text.includes("CHILD_RESULT"));
                expect(message, stderr).toBeGreaterThan(announcement);
                expect(updates.some(entry => state(entry)?.state === "idle")).toBe(true);
            }, {timeout: 15_000});
            if (ending === "complete" || ending === "terminal") {
                // A cold attachment has no cached live ending to mistake for a replayed outcome.
                if (ending === "complete") await request("session/close", {sessionId});
                const replayStart = updates.length;
                await load(sessionId);
                await vi.waitFor(() => expect(updates.slice(replayStart).some(entry => entry.sessionId === childId
                    && entry.update.sessionUpdate === "agent_message_chunk"
                    && entry.update.content.text.includes("CHILD_RESULT")), stderr).toBe(true));
                await vi.waitFor(() => expect(updates.slice(replayStart).some(entry =>
                    state(entry)?.state === "idle" && state(entry)?.stopReason === "end_turn"), stderr).toBe(true));
            }
            expect(updates.some(entry => ["subagent_spawned", "subagent_state_update", "_subagent_update"].includes(entry.update.sessionUpdate))).toBe(false);
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            writeFileSync(join(cwd, "release-child"), "");
            releaseChild();
            connection.close();
            processHandle.kill("SIGTERM");
            if (processHandle.exitCode === null) await once(processHandle, "exit");
            await mock.close();
            await removeDirectoryWithRetry(root);
        }
    });
});
