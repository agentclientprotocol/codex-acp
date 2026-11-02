import * as acp from "@agentclientprotocol/sdk/unstable";
import fs from "node:fs";
import path from "node:path";
import {expect, it} from "vitest";
import {ApprovalOptionId} from "../../permissions/option-ids";
import {
    answerPermissions, connectAndLogin, describeIntegration, expectNoUnscriptedModelRequests,
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
});
