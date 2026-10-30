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

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return false;
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
            expect(isRunning(pid)).toBe(true);

            await agent.connection.request(acp.methods.agent.session.close, {sessionId});

            expect(isRunning(pid)).toBe(false);
            expectNoUnscriptedModelRequests(mock);
        } finally {
            if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && isRunning(pid)) process.kill(pid, "SIGTERM");
            await stopAll(agent, mock);
        }
    });
});
