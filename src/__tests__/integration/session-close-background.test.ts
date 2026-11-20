import * as acp from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import fs from "node:fs";
import path from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {AgentMode} from "../../AgentMode";
import {ApprovalOptionId} from "../../permissions/option-ids";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {
    answerPermissions, connectAndLogin, describeIntegration, expectNoUnscriptedModelRequests, INTEGRATION_MODEL_ID,
    openSession, sendPrompt, spawnAgent, stopAll,
} from "./integration-fixture";
import {execCommandResponse, startMockResponsesServer, textResponse} from "./mock-responses-server";

function processStatus(pid: number): {running: boolean; state: string} {
    try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!;
            // kill(pid, 0) also succeeds for zombies, which have exited but are not reaped yet.
            return {running: state !== "Z" && state !== "X", state};
        }
        return {running: true, state: "present"};
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "ENOENT") throw error;
        return {running: false, state: "gone"};
    }
}

describeIntegration("integration: session close background cleanup", () => {
    it("stops a real Codex background process before close responds, without AIR async tasks", async () => {
        const mock = await startMockResponsesServer();
        let agent: Awaited<ReturnType<typeof spawnAgent>> | undefined;
        let pid: number | undefined;
        try {
            agent = await spawnAgent();
            await connectAndLogin(agent, mock.baseUrl);
            const sessionId = await openSession(agent);
            answerPermissions(agent, "execute", ApprovalOptionId.AllowOnce);
            mock.enqueue(execCommandResponse("background", {
                cmd: "echo $$ > background.pid; exec sleep 120",
                workdir: agent.workspaceDir,
                yield_time_ms: 1000,
                sandbox_permissions: "require_escalated",
                justification: "Test background-process cleanup on session close",
            }), textResponse("Background process started"));
            const response = await sendPrompt(agent, sessionId, "Start the background test process");
            expect(response.stopReason).toBe("end_turn");
            pid = Number(fs.readFileSync(path.join(agent.workspaceDir, "background.pid"), "utf8").trim());
            expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
            expect(processStatus(pid).running).toBe(true);

            await agent.connection.request(acp.methods.agent.session.close, {sessionId});

            const status = processStatus(pid);
            expect(status.running, `Background PID ${pid} is still executing after close (state: ${status.state})`).toBe(false);
            expectNoUnscriptedModelRequests(mock);
        } finally {
            if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && processStatus(pid).running) process.kill(pid, "SIGTERM");
            await stopAll(agent, mock);
        }
    });

    it("lists, resumes, and individually stops real ACP v2 background terminals", async () => {
        const mock = await startMockResponsesServer();
        const temp = path.join(process.cwd(), "tmp");
        fs.mkdirSync(temp, {recursive: true});
        const root = fs.mkdtempSync(path.join(temp, "v2-background-"));
        const cwd = path.join(root, "workspace");
        const codexHome = path.join(root, "codex-home");
        fs.mkdirSync(cwd);
        fs.mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model, model_reasoning_effort: INTEGRATION_MODEL_ID.effort, web_search: "disabled",
        });
        const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
            cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome, INITIAL_AGENT_MODE: AgentMode.AgentFullAccess.id},
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        const updates: v2.UpdateSessionNotification[] = [];
        const connection = v2.client().onNotification(v2.methods.client.session.update, ({params}) => { updates.push(params); })
            .connect(v2.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
        const pids: number[] = [];
        let releaseModel!: (response: string) => void;
        const heldResponse = new Promise<string>(resolve => { releaseModel = resolve; });
        try {
            const agent = connection.agent;
            const methods = v2.methods.agent;
            await agent.request(methods.initialize, {
                protocolVersion: 2, info: {name: "background-fixture", version: "1"},
                capabilities: {auth: {_meta: {gateway: true}}},
            });
            await agent.request(methods.auth.login, {methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}}});
            const {sessionId} = await agent.request(methods.session.new, {cwd});
            // Keep automatic title generation out of the scripted model requests.
            await agent.request(methods.session.setTitle, {sessionId, title: "Background fixture"});
            const background = () => {
                const state = updates.filter(entry => entry.sessionId === sessionId).map(entry => entry.update)
                    .filter(v2.SessionUpdate.isStateUpdate).at(-1);
                return Array.isArray(state?.background) ? state.background.filter(v2.BackgroundWork.isTerminal) : [];
            };
            for (const name of ["first", "second"]) {
                const script = `require('node:fs').writeFileSync('${name}.pid', String(process.pid)); console.log('${name}'); setTimeout(() => {}, 60000);`;
                mock.enqueue(execCommandResponse(`command-${name}`, {
                    cmd: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
                    workdir: cwd, yield_time_ms: 1_000,
                }), textResponse(`Started ${name}`));
                await agent.request(methods.session.prompt, {sessionId, prompt: [{type: "text", text: `Start the ${name} test process`}]});
                await vi.waitFor(() => expect(background(), stderr).toHaveLength(pids.length + 1), {timeout: 10_000});
                const pid = Number(fs.readFileSync(path.join(cwd, `${name}.pid`), "utf8").trim());
                expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
                expect(processStatus(pid).running).toBe(true);
                pids.push(pid);
            }
            const [first, second] = background();
            expect(first).toBeDefined();
            expect(second).toBeDefined();
            const beforeResume = updates.length;
            await agent.request(methods.session.resume, {sessionId, cwd});
            await vi.waitFor(() => {
                const sync = updates.slice(beforeResume).map(({update}) => update);
                for (const item of [first!, second!]) {
                    const announcement = sync.findIndex(update => v2.SessionUpdate.isTerminalUpdate(update)
                        && update.terminalId === item.terminalId && update.capabilities?.cancel != null);
                    const listed = sync.findIndex(update => v2.SessionUpdate.isStateUpdate(update) && Array.isArray(update.background)
                        && update.background.some(entry => v2.BackgroundWork.isTerminal(entry) && entry.terminalId === item.terminalId));
                    expect(announcement, JSON.stringify(sync)).toBeGreaterThanOrEqual(0);
                    expect(listed, JSON.stringify(sync)).toBeGreaterThan(announcement);
                }
            });
            // Hold an unrelated model call open so both cancellations happen during real foreground work.
            let modelWaiting = false;
            mock.setResponseHandler(() => { modelWaiting = true; return heldResponse; });
            await agent.request(methods.session.prompt, {sessionId, prompt: [{type: "text", text: "Keep working in the foreground"}]});
            await vi.waitFor(() => expect(modelWaiting).toBe(true));
            const foregroundStart = updates.length;
            expect(pids.every(pid => processStatus(pid).running)).toBe(true);
            await agent.request(methods.terminal.cancel, {sessionId, terminalId: first!.terminalId});
            await vi.waitFor(() => {
                expect(background()).toEqual([second]);
                expect(processStatus(pids[0]!).running).toBe(false);
            });
            expect(updates.slice(foregroundStart).some(({update}) => v2.SessionUpdate.isStateUpdate(update)
                && update.state === "idle")).toBe(false);

            await agent.notify(methods.session.cancel, {sessionId});
            await vi.waitFor(() => expect(updates.slice(foregroundStart).some(({update}) => v2.SessionUpdate.isStateUpdate(update)
                && update.state === "idle" && update.stopReason === "cancelled"), stderr).toBe(true));
            expect(background()).toEqual([second]);
            expect(processStatus(pids[1]!).running).toBe(true);
            await agent.request(methods.session.close, {sessionId});
            // On macOS the process can still have a PID until the OS reaps it.
            await vi.waitFor(() => expect(processStatus(pids[1]!).running, stderr).toBe(false));
            expectNoUnscriptedModelRequests(mock);
        } finally {
            releaseModel(textResponse("Fixture cleanup"));
            for (const pid of pids) if (processStatus(pid).running) process.kill(pid, "SIGTERM");
            connection.close();
            child.stdin.end();
            if (child.exitCode === null && child.signalCode === null) {
                const timeout = setTimeout(() => child.kill(), 4_000);
                try { await once(child, "exit"); }
                finally { clearTimeout(timeout); }
            }
            await mock.close();
            removeDirectoryWithRetry(root);
        }
    });
});
