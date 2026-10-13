// The model asks to run a shell command; the test user allows or rejects it.
// Read-only mode + `require_escalated` make Codex ask for permission before running it.
import type * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import {afterEach, beforeEach, expect, it} from "vitest";
import {ApprovalOptionId} from "../../permissions/option-ids";
import type {SpawnedAgentFixture} from "../CodexACPAgent/e2e/spawned-agent-fixture";
import {
    answerPermissions,
    connectAndLogin,
    describeIntegration,
    expectNoUnscriptedModelRequests,
    modelRequestInput,
    openSession,
    sendPrompt,
    spawnAgent,
    stopAll,
    toolCallUpdates,
} from "./integration-fixture";
import {execCommandResponse, type MockResponsesServer, startMockResponsesServer, textResponse} from "./mock-responses-server";

const CALL_ID = "call_shell";

describeIntegration("integration: shell approval", () => {
    let mock: MockResponsesServer;
    let agent: SpawnedAgentFixture;
    let sessionId: string;
    // The command creates this file, so its existence shows whether the command ran.
    let marker: string;

    beforeEach(async () => {
        // Start the mock model: a local HTTP server in place of the OpenAI API.
        mock = await startMockResponsesServer();
        // Spawn the agent: the codex-acp process, which starts `codex app-server` itself.
        agent = await spawnAgent();
        // Connect over ACP and log in through `gateway` with the mock's address.
        await connectAndLogin(agent, mock.baseUrl);
        // Open a session in a temp workspace.
        sessionId = await openSession(agent);
        marker = path.join(agent.workspaceDir, "marker.txt");
    });

    // Stop the agent and the mock, remove the temp dirs.
    afterEach(async () => {
        await stopAll(agent, mock);
    });

    /** Model reply: run `touch <marker> && echo shell-ok` with escalated permissions. */
    function modelRunsCommand(): string {
        return execCommandResponse(CALL_ID, {
            cmd: `touch '${marker}' && echo shell-ok`,
            sandbox_permissions: "require_escalated",
            justification: "integration test",
        });
    }

    function commandRan(): boolean {
        return fs.existsSync(marker);
    }

    function expectOnePermissionRequest(): acp.RequestPermissionRequest | undefined {
        const requests = agent.readPermissionRequests(sessionId, "execute");
        expect(requests).toHaveLength(1);
        return requests[0];
    }

    function toolCallWithStatus(status: "completed" | "failed") {
        return toolCallUpdates(agent, sessionId).find((u) => u.status === status);
    }

    /** Codex sent the command output back to the model in its 2nd request. */
    function expectOutputSentToModel(output: string): void {
        expect(mock.requests).toHaveLength(2);
        const sent = modelRequestInput(mock, 1).find((i) => i.type === "function_call_output" && i.call_id === CALL_ID);
        expect(JSON.stringify(sent)).toContain(output);
    }

    /**
     * Scenario:
     * 1. The user sends the prompt "run shell".
     * 2. The model asks to run `touch marker.txt && echo shell-ok`.
     * 3. Codex asks the user for permission; the user allows it once.
     * 4. Codex runs the command and sends its output to the model.
     * 5. The model replies "done".
     * Expected:
     * - the turn ends with `end_turn`;
     * - there was one permission request, with the options allow once / allow with exec policy / cancel;
     * - the tool call completed with the output "shell-ok";
     * - marker.txt exists, so the command really ran;
     * - the model's 2nd request contains the output "shell-ok".
     */
    it("runs the command when the user allows it", async () => {
        // Script the model (run the command, then "done") and the user (allow once).
        mock.enqueue(modelRunsCommand(), textResponse("done"));
        answerPermissions(agent, "execute", ApprovalOptionId.AllowOnce);

        // Send the prompt and wait for the turn to end.
        const response = await sendPrompt(agent, sessionId, "run shell");

        // Check the client, the disk, and what Codex sent to the model.
        expect(response.stopReason).toBe("end_turn");
        expect(expectOnePermissionRequest()?.options.map((o) => o.optionId)).toEqual([
            ApprovalOptionId.AllowOnce, ApprovalOptionId.AcceptWithExecpolicyAmendment, ApprovalOptionId.Cancel,
        ]);
        expect(JSON.stringify(toolCallWithStatus("completed"))).toContain("shell-ok");
        expect(commandRan()).toBe(true);
        expectOutputSentToModel("shell-ok");
        expectNoUnscriptedModelRequests(mock);
    });

    /**
     * Scenario:
     * 1. The user sends the prompt "run shell".
     * 2. The model asks to run `touch marker.txt && echo shell-ok`.
     * 3. Codex asks the user for permission; the user rejects it.
     * Expected:
     * - the turn ends with `cancelled`;
     * - there was one permission request;
     * - the tool call failed;
     * - marker.txt does not exist, so the command never ran;
     * - Codex made no more model requests.
     */
    it("does not run the command when the user rejects it", async () => {
        // Script the model (run the command; no 2nd reply, Codex won't ask after a rejection) and the user (reject).
        mock.enqueue(modelRunsCommand());
        answerPermissions(agent, "execute", ApprovalOptionId.Cancel);

        // Send the prompt and wait for the turn to end.
        const response = await sendPrompt(agent, sessionId, "run shell");

        // Check the client, the disk, and that the model was not called again.
        expect(response.stopReason).toBe("cancelled");
        expectOnePermissionRequest();
        expect(toolCallWithStatus("failed")).toBeDefined();
        expect(commandRan()).toBe(false);
        expectNoUnscriptedModelRequests(mock);
    });
});
